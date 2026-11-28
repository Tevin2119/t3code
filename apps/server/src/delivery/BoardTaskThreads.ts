// A board task's conversation, made by the server once the engine shows the task submitted or in
// work. Engine facts only: its lanes say what started and which thread each task holds, its teams
// say who leads. This never starts a task, and no client asks it to make a thread.
import {
  CommandId,
  MessageId,
  DeliverySeatModels,
  type DeliveryError,
  type DeliveryOrchestrationConfig,
  ModelSelection,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { limitedLeadHandoffThreadId } from "@t3tools/shared/limitedSeat";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as BoardConversation from "./BoardConversation.ts";
import { engineNotice } from "./BoardConversation.ts";
import * as BoardTaskSideChats from "./BoardTaskSideChats.ts";
import { boardTaskInWork, MOVED } from "./boardTaskWork.ts";
import * as BoardThreadRows from "./boardThreadRows.ts";
import {
  boardTaskOf,
  boardTaskOfMarker,
  boardTaskThreadCommandId,
  boardTaskThreadId,
  boardTaskThreadMarker,
  createBoardTaskThread,
  type BoardTask,
} from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";
import { BoardThreadLink, readOrNull } from "./DeliveryService.ts";
import * as LimitedSeatSwap from "./LimitedSeatSwap.ts";
import { BoardLeadSeat, boardLeadSeat, resolveSeatProvider } from "./seatProvider.ts";

const Card = Schema.Struct({
  // What a card is and where its link stands. A card these cannot be read from is skipped.
  id: Schema.String,
  lane: Schema.String,
  state: Schema.String,
  set: Schema.optional(Schema.NullOr(Schema.String)),
  // Absent on an engine without the link: such an engine is never written to.
  boardThread: Schema.optional(Schema.NullOr(BoardThreadLink)),
  // Absent on an engine before slice L2: its side chats are never recorded by the pass.
  relatedThreads: readOrNull(Schema.Array(BoardTaskSideChats.RelatedThreadLink)),
  // A task split into parts: its parts get threads, never the parent (engine slice E1).
  split: readOrNull(Schema.Boolean),
  // When a person submitted the task; null on a draft.
  submitted: readOrNull(Schema.String),
  // Read only to make a thread: without them a task is held as `unreadable-card`.
  title: readOrNull(Schema.String),
  team: readOrNull(Schema.String),
  // Slice 5's mirror and steer counts; absent on an engine before it.
  conversation: Schema.optional(Schema.NullOr(Schema.Unknown)),
  steers: readOrNull(Schema.Struct({ pending: Schema.Number })),
  run: readOrNull(Schema.Struct({ id: Schema.String })),
  seatModels: DeliverySeatModels,
  hold: readOrNull(
    Schema.Struct({
      stage: Schema.String,
      deadline: Schema.String,
      handoff: Schema.NullOr(Schema.Literal("handed")),
    }),
  ),
});
type Card = typeof Card.Type;

// Cards are decoded one at a time, so one this build cannot read never stops the others.
const Lanes = Schema.Struct({
  lanes: Schema.Array(Schema.Struct({ lane: Schema.String, cards: Schema.Array(Schema.Unknown) })),
  sets: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      target: Schema.optional(
        Schema.NullOr(Schema.Struct({ path: Schema.optional(Schema.NullOr(Schema.String)) })),
      ),
    }),
  ),
});
const TeamSeat = Schema.Struct({
  ...BoardLeadSeat.fields,
  harness: Schema.String,
  model: Schema.optional(Schema.NullOr(Schema.String)),
  // Read only for a seat's duty, so a shape this build cannot read never fails the teams.
  stages: Schema.optional(Schema.Unknown),
});
type TeamSeat = typeof TeamSeat.Type;
const Teams = Schema.Array(Schema.Struct({ team: Schema.String, seats: Schema.Array(TeamSeat) }));
type Team = (typeof Teams.Type)[number];
/** What a refusal of the link routes carries: a stable code, and on a conflict the value held. */
const Refusal = Schema.Struct({
  code: Schema.optional(Schema.String),
  current: Schema.optional(Schema.NullOr(BoardThreadLink)),
});
const Linked = Schema.Struct({ boardThread: BoardThreadLink });
const Detail = Schema.Struct({ boardThread: Schema.NullOr(BoardThreadLink) });
const Claimed = Schema.Struct({ holder: Schema.String });

const decodeLanes = Schema.decodeUnknownEffect(Lanes);
const decodeCard = Schema.decodeUnknownResult(Card);
const decodeCardId = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }));
const decodeTeams = Schema.decodeUnknownEffect(Teams);
const decodeRefusal = Schema.decodeUnknownOption(Refusal);
const decodeLinked = Schema.decodeUnknownEffect(Linked);
const decodeDetail = Schema.decodeUnknownOption(Detail);
const decodeClaimed = Schema.decodeUnknownOption(Claimed);
/** What a task's own detail says of where it stands: all a card is judged by when it can't be read. */
const TaskStanding = Schema.Struct({
  state: Schema.String,
  lane: Schema.optional(Schema.NullOr(Schema.String)),
  boardThread: Schema.optional(
    Schema.NullOr(Schema.Struct({ environmentId: Schema.String, threadId: Schema.String })),
  ),
});
type TaskStanding = typeof TaskStanding.Type;
const decodeStanding = Schema.decodeUnknownOption(TaskStanding);
const decodeSelection = Schema.decodeUnknownEffect(ModelSelection);
/** The task as a person filed it, from its own detail. */
const Filed = Schema.Struct({
  body: readOrNull(Schema.String),
  acceptance: readOrNull(Schema.Array(Schema.String)),
});
const decodeFiled = Schema.decodeUnknownOption(Filed);

/** Every task of every board, with each card's link joined once by the engine. */
export const LANES_PATH = "/api/lanes?view=development&set=all";

/**
 * The model the engine picked for a seat. A seat picked only when it runs, or whose pick this
 * build cannot read, runs on its roster model, as with no picks.
 */
const pickOf = (seat: TeamSeat, seatModels: Card["seatModels"]) => {
  const published = seatModels?.[seat.seat];
  return seatModels === undefined || published === null || published?.model === null
    ? seat
    : published;
};

/** What a seat does in its team, read from its stages as the web reads it. */
const dutyOf = (stages: unknown) =>
  !Array.isArray(stages)
    ? undefined
    : stages.includes("qa")
      ? ("qa" as const)
      : stages.includes("build")
        ? ("build" as const)
        : undefined;

/** The most participants a lineup takes (`DeliveryOrchestrationConfig`). */
const MAX_PARTICIPANTS = 12;

// Lanes of a submitted task that waits for a slot. `intake` and `ready` are an older engine's.
const WAITING = new Set(["queue", "intake", "ready"]);

/**
 * A task submitted since this server started, waiting for a slot: it gets its thread now, with no
 * claim. One submitted earlier gets its thread when it is in work, as before.
 */
const submittedSince = (card: Card, since: number) =>
  WAITING.has(card.lane) &&
  !MOVED.has(card.state) &&
  card.split !== true &&
  card.submitted != null &&
  Date.parse(card.submitted) >= since;

/** A task submitted or in work with no conversation: this pass links it to its thread. */
const awaitsThread = (card: Card, since: number) =>
  card.boardThread === null && (boardTaskInWork(card) || submittedSince(card, since));

/** The thread's first message: the task as filed, from no person. */
const filedText = (title: string, filed: typeof Filed.Type) => {
  const acceptance = (filed.acceptance ?? []).map((line) => `- ${line}`).join("\n");
  return [
    `# ${title}`,
    filed.body?.trim() ?? "",
    acceptance === "" ? "" : `Acceptance:\n${acceptance}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
};

/**
 * How a thread this server made stands with its task, as the engine's lanes show it: `linked` is
 * the task's conversation, `free` may still become it, and a `displaced` or `moved` one never
 * will here (another conversation holds the task, or it is worked on another machine). The pass
 * archives the last two, and the board's archive offers no restore for them.
 */
export const boardThreadStanding = (
  card: {
    readonly state: string;
    readonly boardThread?:
      | { readonly environmentId: string; readonly threadId: string }
      | null
      | undefined;
  },
  environmentId: string,
  threadId: string,
) => {
  const link = card.boardThread;
  if (link) {
    return link.environmentId === environmentId && link.threadId === threadId
      ? ("linked" as const)
      : ("displaced" as const);
  }
  return MOVED.has(card.state) ? ("moved" as const) : ("free" as const);
};

/**
 * The standing of a thread whose task the lanes do not list, or list on a card this build cannot
 * read, from the task's own detail. The engine gives a task that moved to another machine no
 * lane, and still answers for it with its state. Any other task is judged only when another
 * conversation holds it (`displaced`); otherwise `null`, not judged here.
 */
export const unlistedTaskStanding = (detail: unknown, environmentId: string, threadId: string) => {
  const task = decodeStanding(detail);
  if (Option.isNone(task)) return null;
  const standing = boardThreadStanding(task.value, environmentId, threadId);
  return MOVED.has(task.value.state) || standing === "displaced" ? standing : null;
};

/** Why a started task has no conversation of its own yet. Told in the log, never guessed around. */
export type BoardThreadHold =
  | "no-board"
  | "unmarkable-id"
  | "no-project"
  | "no-lead"
  | "no-lead-model"
  | "no-teams"
  | "no-provider"
  | "ambiguous-provider"
  | "foreign-thread"
  | "archived-thread"
  | "no-key"
  | "refused"
  | "unreadable-card"
  | "moved";

export class BoardTaskThreadsError extends Schema.TaggedError<BoardTaskThreadsError>()(
  "BoardTaskThreadsError",
  {
    reason: Schema.Literals(["engine", "thread"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class BoardTaskThreads extends Context.Service<
  BoardTaskThreads,
  {
    /** One pass over the engine's lanes. Safe to repeat and to run twice at once. */
    readonly reconcile: () => Effect.Effect<
      ReadonlyMap<string, BoardThreadHold>,
      BoardTaskThreadsError
    >;
    /**
     * Claims a task for its conversation here, or renews the claim this server holds: whether it
     * holds it now. A step T3 runs for the engine keeps its task's claim alive with this, so the
     * engine never takes the step for abandoned while T3 works it.
     */
    readonly holdTask: (taskId: string, threadId: ThreadId) => Effect.Effect<boolean>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/delivery/BoardTaskThreads") {}

const refusalOf = (error: DeliveryError) => {
  const decoded = decodeRefusal(error.body);
  return {
    status: error.status ?? null,
    code: Option.isSome(decoded) ? (decoded.value.code ?? null) : null,
    current: Option.isSome(decoded) ? (decoded.value.current ?? null) : null,
  };
};

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const delivery = yield* DeliveryService.DeliveryService;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const rows = yield* BoardThreadRows.BoardThreadRows;
  const conversation = yield* BoardConversation.BoardConversation;
  const sideChats = yield* BoardTaskSideChats.BoardTaskSideChats;
  const swaps = yield* LimitedSeatSwap.LimitedSeatSwap;
  const lock = yield* Semaphore.make(1);
  // Tasks submitted before this are not given a thread until they are in work (no backfill).
  const since = yield* Clock.currentTimeMillis;
  // The token of each claim this server holds. It is kept in memory only: after a restart the
  // old lease lapses within its window and the task is claimed again, still by the same thread.
  const holders = new Map<string, string>();
  const told = new Map<string, BoardThreadHold>();
  const toldTeamless = new Set<string>();
  const toldUnread = new Map<string, string>();

  const engine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new BoardTaskThreadsError({ reason: "engine", cause })));
  const local = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new BoardTaskThreadsError({ reason: "thread", cause })));

  const enabledInstances = instances.listInstances.pipe(
    Effect.map((list) => list.filter((instance) => instance.enabled)),
  );

  /** The model a seat runs on here, or why it cannot run. */
  const selectionOf = Effect.fn("BoardTaskThreads.selectionOf")(function* (
    providers: Effect.Success<typeof enabledInstances>,
    pick: { readonly harness: string; readonly model?: string | null | undefined } | undefined,
  ) {
    if (!pick?.model) return "no-model" as const;
    const instance = resolveSeatProvider(providers, pick.harness, (entry) => entry.instanceId);
    if (typeof instance === "string") return instance;
    // A pick this build cannot read, such as a blank model, leaves the seat with no model.
    const selection = yield* decodeSelection({
      instanceId: instance.instanceId,
      model: pick.model,
    }).pipe(Effect.option);
    return Option.isSome(selection) ? selection.value : ("no-model" as const);
  });

  const leadSelection = Effect.fn("BoardTaskThreads.leadSelection")(function* (
    team: Team | undefined,
    seatModels: Card["seatModels"],
  ) {
    const lead = boardLeadSeat(team?.seats ?? []);
    if (lead === undefined) return "no-lead" as const;
    const selection = yield* selectionOf(yield* enabledInstances, pickOf(lead, seatModels));
    return selection === "no-model" ? ("no-lead-model" as const) : selection;
  });

  /**
   * The team a task's conversation shows, as a hand-started Orchestrator thread would: every seat
   * but the lead's, on the engine's picks. Seats stay read-only, and nothing here swaps a seat:
   * the engine picks. A seat that cannot run here is left out; with none left there is no lineup.
   */
  const lineupOf = Effect.fn("BoardTaskThreads.lineupOf")(function* (
    team: Team,
    seatModels: Card["seatModels"],
  ) {
    const lead = boardLeadSeat(team.seats);
    const providers = yield* enabledInstances;
    const participants: Array<DeliveryOrchestrationConfig["participants"][number]> = [];
    for (const seat of team.seats) {
      if (seat === lead) continue;
      // Picks that leave a seat out say nothing of it, so it runs on its roster model.
      const pick = seatModels?.[seat.seat] === undefined ? seat : pickOf(seat, seatModels);
      const modelSelection = yield* selectionOf(providers, pick);
      if (typeof modelSelection === "string") continue;
      const duty = dutyOf(seat.stages);
      participants.push({
        seat: seat.seat,
        role: seat.role?.trim() || seat.seat,
        modelSelection,
        ...(duty === undefined ? {} : { duty }),
      });
    }
    if (participants.length === 0) return null;
    return {
      team: team.team,
      participants: participants.slice(0, MAX_PARTICIPANTS),
    } satisfies DeliveryOrchestrationConfig;
  });

  /**
   * Shows a task's conversation its team as the board picks it now, on every pass, so a new pick
   * or a seat that can now run reaches it. The board's lineup is the only one such a thread has.
   * A team with no seat but its lead's that runs here shows none, which is said once.
   */
  const showTeam = Effect.fn("BoardTaskThreads.showTeam")(function* (
    taskId: string,
    threadId: ThreadId,
    team: Team,
    seatModels: Card["seatModels"],
  ) {
    const lineup = yield* lineupOf(team, seatModels);
    if (lineup !== null) toldTeamless.delete(taskId);
    else if (!toldTeamless.has(taskId)) {
      toldTeamless.add(taskId);
      yield* Effect.logInfo(
        "A board task's conversation has no team to show: no seat but its lead's runs here.",
        { task: taskId, team: team.team },
      );
    }
    yield* delivery.setBoardLineup(threadId, lineup);
  });

  /**
   * Archives a thread that holds no task. The command id carries the thread's revision, so a pass
   * repeated over the same state is answered by the first archive, and a thread a person restored
   * since is archived anew: without it the first archive's receipt would answer every later one,
   * and the restored thread would stay open, in no list and not in the board's archive.
   */
  const archive = (task: BoardTask, threadId: ThreadId, why: string, revision: number) =>
    local(
      threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(
          `${boardTaskThreadMarker(task)}:archive:${threadId}:${why}:${revision}`,
        ),
        threadId,
      }),
    ).pipe(Effect.asVoid);

  /** Renews this server's lease on a task now: whether the engine still says it holds it. */
  const renewClaim = Effect.fn("BoardTaskThreads.renewClaim")(function* (taskId: string) {
    const held = holders.get(taskId);
    if (held === undefined) return false;
    const renewed = yield* delivery
      .boardThreadAct({
        method: "POST",
        path: `/api/orchestration/tasks/${taskId}/ack`,
        body: { holder: held },
      })
      .pipe(Effect.result);
    if (renewed._tag === "Success") return true;
    holders.delete(taskId);
    return false;
  });

  /**
   * The claim of a task whose conversation is this server's, and its heartbeat. A refusal is the
   * engine's answer (the cap is reached, the task is paused, another holder's lease still stands)
   * and changes nothing here: the next pass asks again.
   */
  const holdClaim = Effect.fn("BoardTaskThreads.holdClaim")(function* (
    taskId: string,
    environmentId: EnvironmentId,
    threadId: string,
  ) {
    const path = `/api/orchestration/tasks/${taskId}`;
    if (yield* renewClaim(taskId)) return;
    const claimed = yield* delivery
      .boardThreadAct({
        method: "POST",
        path: `${path}/claim`,
        // The opt-in asks the engine to hold its QA stage for the lead's hand-off.
        body: {
          origin: `thread:${environmentId}/${threadId}`,
          by: environmentId,
          handoffs: ["qa"],
        },
      })
      .pipe(Effect.result);
    if (claimed._tag !== "Success") return;
    const decoded = decodeClaimed(claimed.success.body);
    if (Option.isSome(decoded)) holders.set(taskId, decoded.value.holder);
  });

  const releaseClaim = Effect.fn("BoardTaskThreads.releaseClaim")(function* (taskId: string) {
    const holder = holders.get(taskId);
    if (holder === undefined) return;
    holders.delete(taskId);
    yield* delivery
      .boardThreadAct({
        method: "POST",
        path: `/api/orchestration/tasks/${taskId}/release`,
        body: { holder },
      })
      .pipe(Effect.ignore);
  });

  const linkThread = Effect.fn("BoardTaskThreads.linkThread")(function* (input: {
    readonly task: BoardTask;
    readonly threadId: ThreadId;
    readonly revision: number;
    readonly environmentId: EnvironmentId;
    readonly key: string;
  }) {
    const { task, threadId, revision, environmentId, key } = input;
    const put = yield* delivery
      .boardThreadAct({
        method: "PUT",
        path: `/api/tasks/${task.id}/board-thread`,
        // No link was set when the lanes were read. A writer in between is answered 409.
        body: { environmentId, threadId, setBy: environmentId, expect: null, key },
      })
      .pipe(Effect.result);
    if (put._tag === "Success") {
      const { boardThread } = yield* engine(decodeLinked(put.success.body));
      return { boardThread, hold: null };
    }
    // The refusal's `code` decides, never its words.
    const refusal = refusalOf(put.failure);
    if (refusal.code === "conflict") {
      const read = yield* delivery.read({ path: `/api/tasks/${task.id}` }).pipe(Effect.result);
      const detail = read._tag === "Success" ? decodeDetail(read.success.body) : Option.none();
      const boardThread = Option.isSome(detail) ? detail.value.boardThread : refusal.current;
      if (boardThread?.environmentId !== environmentId || boardThread.threadId !== threadId)
        yield* archive(task, threadId, "displaced", revision);
      return { boardThread, hold: null };
    }
    if (refusal.code === "moved" || refusal.code === "not-found") {
      yield* archive(task, threadId, refusal.code === "moved" ? "moved" : "deleted", revision);
      return { hold: refusal.code === "moved" ? ("moved" as const) : null };
    }
    if (refusal.code === "refused") return { hold: "refused" as const };
    return yield* new BoardTaskThreadsError({ reason: "engine", cause: put.failure });
  });

  /** A started task with no conversation: make its thread once, and tell the engine. */
  const bind = Effect.fn("BoardTaskThreads.bind")(function* (
    card: Card,
    context: {
      readonly environmentId: EnvironmentId;
      readonly teams: typeof Teams.Type;
      readonly folders: ReadonlyMap<string, string>;
      readonly key: string | undefined;
      readonly revisions: ReadonlyMap<string, number>;
    },
  ) {
    if (!card.set) return "no-board" as const;
    const { title, team } = card;
    if (title == null || team == null) return "unreadable-card" as const;
    const task = boardTaskOf(card.set, card.id);
    if (task === null) return "unmarkable-id" as const;
    const threadId = boardTaskThreadId(task);
    const revision = context.revisions.get(threadId) ?? 0;
    const folder = context.folders.get(card.set);
    const project =
      folder === undefined
        ? Option.none()
        : yield* local(projects.findActiveByWorkspaceRoot(folder));
    if (Option.isNone(project)) return "no-project" as const;
    const roster = context.teams.find((entry) => entry.team === team);
    const modelSelection = yield* leadSelection(roster, card.seatModels);
    if (typeof modelSelection === "string") return modelSelection;
    if (roster === undefined) return "no-lead" as const;
    // The command id is the task's, so a second start, a second server pass and a restart between
    // this create and the link below all answer with the one thread. The marker is stamped here
    // and by nothing later.
    yield* local(
      threads.dispatch(
        createBoardTaskThread(task, {
          commandId: boardTaskThreadCommandId(task),
          threadId,
          projectId: project.value.projectId,
          title,
          modelSelection,
        }),
      ),
    );
    const created = yield* local(projections.getThreadRecords(threadId, []));
    const stamped = boardTaskOfMarker(created.thread.lineage.engineIntake);
    if (stamped?.board !== task.board || stamped.id !== task.id) return "foreign-thread" as const;
    // Before any message, and the lineup only: the lead needs no engine tools, so no binding.
    yield* showTeam(card.id, threadId, roster, card.seatModels);
    // An archived thread is never linked: it was displaced, its task was refused for good, or a
    // person archived it. Restoring it from the board's archive is what lets it be linked.
    if (created.thread.archivedAt !== null) return "archived-thread" as const;
    if (context.key === undefined) return "no-key" as const;
    const inWork = boardTaskInWork(card);
    // Sent before the link, so a pass that cannot read the task tries both again on the next.
    if (!inWork) {
      const read = yield* delivery.read({ path: `/api/tasks/${card.id}` }).pipe(Effect.result);
      const filed = read._tag === "Success" ? decodeFiled(read.success.body) : Option.none();
      if (Option.isNone(filed)) return "unreadable-card" as const;
      const text = filedText(title, filed.value);
      yield* local(
        threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${boardTaskThreadMarker(task)}:filed`),
          threadId,
          messageId: MessageId.make(`message:board-task-filed:${task.board}:${task.id}`),
          text,
          // A notice, so it starts no team round, and is said by no person.
          notification: engineNotice("The task as filed", text),
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        }),
      );
    }
    const { boardThread, hold } = yield* linkThread({
      task,
      threadId,
      revision,
      environmentId: context.environmentId,
      key: context.key,
    });
    // A task waiting for a slot holds no claim: it is claimed once it is in work.
    if (
      inWork &&
      boardThread?.environmentId === context.environmentId &&
      boardThread.threadId === threadId
    )
      yield* holdClaim(card.id, context.environmentId, threadId);
    return hold;
  });

  /**
   * The open threads this server made whose task ended here: deleted in the engine, held by
   * another conversation, or moved to another machine without keeping this one. They are
   * archived, never deleted, and the board lists them. A thread a person restored is judged like
   * any other, so one whose task is still gone goes back to the archive on the next pass.
   */
  /**
   * Where each task stands: its card, or, for a task with an open thread here that the lanes
   * leave out or list on a card this build cannot read, its own detail, judged by the same rules.
   * Only the engine's 404 says a task was deleted; no answer leaves it for the next pass.
   */
  const standingsOf = Effect.fn("BoardTaskThreads.standingsOf")(function* (
    cards: ReadonlyMap<string, Card>,
    openThreads: ReadonlyArray<BoardThreadRows.BoardThreadRow>,
  ) {
    const standings = new Map<string, TaskStanding | "deleted">(cards);
    for (const taskId of new Set(openThreads.map((row) => row.task.id))) {
      if (standings.has(taskId)) continue;
      const read = yield* delivery.read({ path: `/api/tasks/${taskId}` }).pipe(Effect.result);
      const task = read._tag === "Success" ? decodeStanding(read.success.body) : Option.none();
      if (Option.isSome(task)) standings.set(taskId, task.value);
      else if (read._tag === "Failure" && read.failure.status === 404)
        standings.set(taskId, "deleted");
    }
    return standings;
  });

  const settleEnded = Effect.fn("BoardTaskThreads.settleEnded")(function* (input: {
    readonly cards: Map<string, Card>;
    readonly standings: Map<string, TaskStanding | "deleted">;
    readonly openThreads: ReadonlyArray<BoardThreadRows.BoardThreadRow>;
    readonly environmentId: EnvironmentId;
  }) {
    const { cards, standings, openThreads, environmentId } = input;
    const byThread = new Map(openThreads.map((row) => [row.threadId, row]));
    const pending = new Set<ThreadId>();
    // Both rows must remain open until the continuation and link move finish.
    for (const [taskId, taskRows] of Map.groupBy(openThreads, (row) => row.task.id)) {
      const task = standings.get(taskId);
      if (taskRows.length < 2 || task === undefined || task === "deleted") continue;
      const link = task.boardThread;
      if (link?.environmentId !== environmentId || MOVED.has(task.state)) continue;
      for (const row of taskRows) {
        const shell = yield* local(projections.getThreadShell(row.threadId));
        if (!shell?.latestRunId) continue;
        const target = limitedLeadHandoffThreadId(shell.latestRunId);
        const successor = byThread.get(target);
        if (
          successor?.task.id !== taskId ||
          successor.task.board !== row.task.board ||
          (link.threadId !== row.threadId && link.threadId !== target)
        )
          continue;
        pending.add(row.threadId);
        pending.add(target);
        // The successor continues the lead's work: a task out of work, such as a split parent,
        // keeps both threads until it is back in work.
        if (!boardTaskInWork(task)) break;
        // Only under this server's claim, renewed now: a lease that lapsed earlier in a long pass,
        // or one refused at the task cap, waits for a later pass.
        if (!(yield* renewClaim(taskId))) break;
        const resumed = yield* swaps
          .resumeBoardLeadHandoff(row.task, shell, shell.latestRunId)
          .pipe(Effect.result);
        // One task's hand-off never stops the pass: it is tried again on the next one.
        if (resumed._tag === "Failure") {
          yield* Effect.logWarning("A board lead hand-off did not finish.", {
            task: taskId,
            cause: resumed.failure.message,
          });
          break;
        }
        const boardThread = resumed.success;
        if (boardThread === null) break;
        pending.delete(row.threadId);
        pending.delete(target);
        standings.set(taskId, { ...task, boardThread });
        const card = cards.get(taskId);
        if (card !== undefined) cards.set(taskId, { ...card, boardThread });
        break;
      }
    }
    for (const row of openThreads) {
      if (pending.has(row.threadId)) continue;
      const task = standings.get(row.task.id);
      if (task === undefined) continue;
      if (task === "deleted") {
        yield* releaseClaim(row.task.id);
        yield* archive(row.task, row.threadId, "deleted", row.revision);
        continue;
      }
      const standing = boardThreadStanding(task, environmentId, row.threadId);
      if (standing === "free") continue;
      if (standing === "linked") {
        // A moved task takes no work here, even where it kept this thread as its conversation.
        if (MOVED.has(task.state)) yield* releaseClaim(row.task.id);
        continue;
      }
      const link = task.boardThread;
      const owner =
        link?.environmentId === environmentId ? byThread.get(link.threadId as ThreadId) : undefined;
      if (owner?.task.id !== row.task.id || owner.task.board !== row.task.board)
        yield* releaseClaim(row.task.id);
      yield* archive(row.task, row.threadId, standing, row.revision);
    }
  });

  /**
   * Every open conversation of a task the lanes list shows its team as the board picks it now,
   * those made before task threads had a team included. Teams that cannot be read leave each
   * thread with the team it shows, until a later pass.
   */
  const refreshTeams = Effect.fn("BoardTaskThreads.refreshTeams")(function* (input: {
    readonly cards: ReadonlyMap<string, Card>;
    readonly openThreads: ReadonlyArray<BoardThreadRows.BoardThreadRow>;
    readonly teams: Effect.Effect<typeof Teams.Type, BoardTaskThreadsError>;
  }) {
    const shown = input.openThreads.flatMap((row) => {
      const card = input.cards.get(row.task.id);
      return card?.team == null ? [] : [{ row, card, team: card.team }];
    });
    if (shown.length === 0) return;
    const teams = yield* input.teams.pipe(Effect.result);
    if (teams._tag === "Failure")
      return yield* Effect.logDebug("Board teams were not read; task threads keep their team.");
    for (const { row, card, team } of shown) {
      const roster = teams.success.find((entry) => entry.team === team);
      // Showing a team cannot fail: a pick this build cannot read leaves only that seat out.
      if (roster !== undefined) yield* showTeam(card.id, row.threadId, roster, card.seatModels);
    }
  });

  const reconcile = Effect.fn("BoardTaskThreads.reconcile")(
    function* () {
      const holds = new Map<string, BoardThreadHold>();
      // Every open thread made for a board task is the board's from its marker, before anything
      // is asked of the engine: a session starting while the engine is away agrees with what
      // the thread shows.
      for (const row of yield* local(rows.list({ archived: false })))
        yield* delivery.ownBoardThread(row.threadId);
      const config = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
      if (config === null || !config.delivery.enabled) return holds;
      const environmentId = yield* identity.getEnvironmentId;
      const lanes = yield* engine(delivery.read({ path: LANES_PATH })).pipe(
        Effect.flatMap((response) => engine(decodeLanes(response.body))),
        // Unread lanes leave every task unknown: steers wait out their window, notices post.
        Effect.tapError(() => conversation.settleSteers({ standings: new Map(), environmentId })),
      );
      const cards = new Map<string, Card>();
      const unread = new Map<string, string>();
      for (const lane of lanes.lanes) {
        for (const [index, raw] of lane.cards.entries()) {
          const card = decodeCard(raw);
          if (card._tag === "Success") cards.set(card.success.id, card.success);
          else {
            const id = decodeCardId(raw).pipe(
              Option.match({ onNone: () => `${lane.lane}[${index}]`, onSome: ({ id }) => id }),
            );
            unread.set(id, card.failure.message);
          }
        }
      }
      for (const [card, why] of unread) {
        if (toldUnread.get(card) === why) continue;
        yield* Effect.logWarning("A board card could not be read; it is skipped.", { card, why });
      }
      toldUnread.clear();
      for (const [card, why] of unread) toldUnread.set(card, why);
      // An engine that serves no `boardThread` has no link to write to. Nothing is made for it,
      // but the steers of the tasks that do show a link are still settled.
      if ([...cards.values()].some((card) => card.boardThread === undefined)) {
        const linked = [...cards].filter(([, card]) => card.boardThread !== undefined);
        yield* conversation.settleSteers({ standings: new Map(linked), environmentId });
        return holds;
      }
      const starting = [...cards.values()].filter((card) => awaitsThread(card, since));
      const key = yield* delivery.boardApprovalKey;
      // Read at most once a pass, and only by a pass that needs the seats.
      const teamsOf = yield* Effect.cached(
        engine(delivery.read({ path: "/api/teams" })).pipe(
          Effect.flatMap((response) => engine(decodeTeams(response.body))),
        ),
      );
      if (starting.length > 0) {
        const revisions = new Map(
          (yield* local(rows.list({ archived: false }))).map((row) => [row.threadId, row.revision]),
        );
        const teams = yield* teamsOf.pipe(Effect.result);
        const folders = new Map(
          lanes.sets.flatMap((set) =>
            set.target?.path ? [[set.id, set.target.path] as const] : [],
          ),
        );
        for (const card of starting) {
          // Teams that cannot be read hold the tasks that wait for a thread, and only them.
          const hold =
            teams._tag === "Failure"
              ? ("no-teams" as const)
              : yield* bind(card, {
                  environmentId,
                  teams: teams.success,
                  folders,
                  key,
                  revisions,
                });
          if (hold !== null) holds.set(card.id, hold);
        }
      }
      const openThreads = yield* local(rows.list({ archived: false }));
      const standings = yield* standingsOf(cards, openThreads);
      // The steer ledger is settled for every thread, before any card is filtered out.
      yield* conversation.settleSteers({ standings, environmentId });
      const steering = new Set<string>();
      for (const [taskId, task] of standings) {
        if (task === "deleted") continue;
        const link = task.boardThread;
        if (link === null || link === undefined || link.environmentId !== environmentId) continue;
        if (!boardTaskInWork(task)) {
          yield* releaseClaim(taskId);
          continue;
        }
        steering.add(taskId);
        yield* holdClaim(taskId, environmentId, link.threadId);
      }
      yield* settleEnded({ cards, standings, openThreads, environmentId });
      yield* refreshTeams({ cards, openThreads, teams: teamsOf });
      // Moved tasks are worked on another machine: their conversation is not told from here.
      const mirrored = [...cards.values()].filter((card) => !MOVED.has(card.state));
      if (key !== undefined) {
        yield* conversation.sync({ cards: mirrored, steering, environmentId, key });
        yield* sideChats.sync({ cards, environmentId, key });
      }
      // Again, so words the mirror saw this pass are told in it.
      yield* conversation.settleSteers({ standings, environmentId });
      for (const [task, hold] of holds) {
        if (told.get(task) === hold) continue;
        yield* Effect.logWarning("A started board task has no conversation yet.", { task, hold });
      }
      told.clear();
      for (const [task, hold] of holds) told.set(task, hold);
      return holds;
    },
    (effect) => lock.withPermits(1)(effect),
  );

  const start = Effect.fn("BoardTaskThreads.start")(function* () {
    // The engine pushes nothing to T3, so its lanes are read on a beat well inside the claim's
    // lease window (120 seconds); the same pass is the claim's heartbeat and restart catch-up.
    yield* forkParked(
      reconcile().pipe(
        Effect.catchCause(() =>
          Effect.logDebug("Board task threads were not reconciled; the engine keeps its state."),
        ),
        Effect.repeat(Schedule.spaced("30 seconds")),
      ),
    );
  });
  const holdTask = Effect.fn("BoardTaskThreads.holdTask")(function* (
    taskId: string,
    threadId: ThreadId,
  ) {
    yield* holdClaim(taskId, yield* identity.getEnvironmentId, threadId);
    return holders.has(taskId);
  });
  return BoardTaskThreads.of({ reconcile, holdTask, start });
});

export const layer = Layer.effect(BoardTaskThreads, make);
