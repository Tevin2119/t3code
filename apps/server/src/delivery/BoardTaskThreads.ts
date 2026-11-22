// A board task's conversation, made by the server once the engine shows the task in work. Engine
// facts only: its lanes say what started and which thread each task holds, its teams say who
// leads. This never starts a task, and no client asks it to make a thread.
import {
  DELIVERY_HARNESS_BY_DRIVER,
  CommandId,
  type DeliveryError,
  ModelSelection,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import * as BoardThreadRows from "./boardThreadRows.ts";
import {
  boardTaskOfMarker,
  boardTaskThreadCommandId,
  boardTaskThreadId,
  boardTaskThreadMarker,
  type BoardTask,
} from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";

/** The engine's `boardThread` (spec 6a). The field names are the engine's and are not renamed. */
const BoardThread = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
  setBy: Schema.String,
  setAt: Schema.String,
});
type BoardThread = typeof BoardThread.Type;

const Card = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  team: Schema.String,
  lane: Schema.String,
  state: Schema.String,
  set: Schema.optional(Schema.NullOr(Schema.String)),
  // Absent on an engine without the link: such an engine is never written to.
  boardThread: Schema.optional(Schema.NullOr(BoardThread)),
});
type Card = typeof Card.Type;

const Lanes = Schema.Struct({
  lanes: Schema.Array(Schema.Struct({ lane: Schema.String, cards: Schema.Array(Card) })),
  sets: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      target: Schema.optional(
        Schema.NullOr(Schema.Struct({ path: Schema.optional(Schema.NullOr(Schema.String)) })),
      ),
    }),
  ),
});
const Teams = Schema.Array(
  Schema.Struct({
    team: Schema.String,
    seats: Schema.Array(
      Schema.Struct({
        seat: Schema.String,
        role: Schema.optional(Schema.NullOr(Schema.String)),
        harness: Schema.String,
        model: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);
/** What a refusal of the link routes carries: a stable code, and on a conflict the value held. */
const Refusal = Schema.Struct({
  code: Schema.optional(Schema.String),
  current: Schema.optional(Schema.NullOr(BoardThread)),
});
const Linked = Schema.Struct({ boardThread: BoardThread });
const Claimed = Schema.Struct({ holder: Schema.String });

const decodeLanes = Schema.decodeUnknownEffect(Lanes);
const decodeTeams = Schema.decodeUnknownEffect(Teams);
const decodeRefusal = Schema.decodeUnknownOption(Refusal);
const decodeLinked = Schema.decodeUnknownEffect(Linked);
const decodeClaimed = Schema.decodeUnknownOption(Claimed);
const decodeSelection = Schema.decodeUnknownEffect(ModelSelection);

/** Every task of every board, with each card's link joined once by the engine. */
const LANES_PATH = "/api/lanes?view=development&set=all";

// A task in one of these lanes has not started or is not a task run: it has no conversation yet.
// `intake` and `ready` are what an engine before the queue lane calls the same wait.
const NOT_STARTED = new Set(["draft", "chat", "queue", "intake", "ready"]);
// Finished work keeps the conversation it had and is given none anew.
const FINISHED = new Set(["completed", "closed-not-done"]);
// A task that moved is worked on another machine; the engine refuses its link here (`moved`).
const MOVED = new Set(["moved", "moving"]);

/**
 * The engine's approval key, when the host gives this server one. The link routes are keyed
 * (spec 6a) and a server holds no person's passphrase, so without this the link is not written.
 */
export const BOARD_THREAD_KEY_VARIABLE = "T3_DELIVERY_BOARD_THREAD_KEY";

/** Why a started task has no conversation of its own yet. Told in the log, never guessed around. */
export type BoardThreadHold =
  | "no-board"
  | "no-project"
  | "no-lead"
  | "no-lead-model"
  | "no-provider"
  | "ambiguous-provider"
  | "foreign-thread"
  | "no-key"
  | "refused"
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
  const hostEnvironment = yield* HostProcess.Environment;
  const lock = yield* Semaphore.make(1);
  // The token of each claim this server holds. It is kept in memory only: after a restart the
  // old lease lapses within its window and the task is claimed again, still by the same thread.
  const holders = new Map<string, string>();
  const told = new Map<string, BoardThreadHold>();

  const engine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new BoardTaskThreadsError({ reason: "engine", cause })));
  const local = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new BoardTaskThreadsError({ reason: "thread", cause })));

  /** The lead's provider and model, from the engine's team configuration and nothing else. */
  const leadSelection = Effect.fn("BoardTaskThreads.leadSelection")(function* (
    team: (typeof Teams.Type)[number] | undefined,
  ) {
    const lead =
      team?.seats.find((seat) => seat.role === "team-lead") ??
      team?.seats.find((seat) => seat.seat === "lead");
    if (lead === undefined) return "no-lead" as const;
    if (!lead.model) return "no-lead-model" as const;
    const candidates = (yield* instances.listInstances).filter(
      (instance) =>
        instance.enabled && DELIVERY_HARNESS_BY_DRIVER[instance.driverKind] === lead.harness,
    );
    // Two instances of one harness are two accounts: the engine names a harness, not an account,
    // so only the driver's own default instance or a sole instance is the one it means.
    const instance =
      candidates.find(
        (candidate) => String(candidate.instanceId) === String(candidate.driverKind),
      ) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (instance === undefined) {
      return candidates.length === 0 ? ("no-provider" as const) : ("ambiguous-provider" as const);
    }
    return yield* local(decodeSelection({ instanceId: instance.instanceId, model: lead.model }));
  });

  const archive = (task: BoardTask, threadId: ThreadId, why: string) =>
    local(
      threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`${boardTaskThreadMarker(task)}:archive:${why}`),
        threadId,
      }),
    ).pipe(Effect.asVoid);

  /**
   * The claim of a task whose conversation is this server's, and its heartbeat. A refusal is the
   * engine's answer (the cap is reached, the task is paused, another holder's lease still stands)
   * and changes nothing here: the next pass asks again.
   */
  const holdClaim = Effect.fn("BoardTaskThreads.holdClaim")(function* (
    card: Card,
    environmentId: EnvironmentId,
    threadId: string,
  ) {
    const path = `/api/orchestration/tasks/${card.id}`;
    const held = holders.get(card.id);
    if (held !== undefined) {
      const renewed = yield* delivery
        .boardThreadAct({ method: "POST", path: `${path}/ack`, body: { holder: held } })
        .pipe(Effect.result);
      if (renewed._tag === "Success") return;
      holders.delete(card.id);
    }
    const claimed = yield* delivery
      .boardThreadAct({
        method: "POST",
        path: `${path}/claim`,
        body: { origin: `thread:${environmentId}/${threadId}`, by: environmentId },
      })
      .pipe(Effect.result);
    if (claimed._tag !== "Success") return;
    const decoded = decodeClaimed(claimed.success.body);
    if (Option.isSome(decoded)) holders.set(card.id, decoded.value.holder);
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

  /** A started task with no conversation: make its thread once, and tell the engine. */
  const bind = Effect.fn("BoardTaskThreads.bind")(function* (
    card: Card,
    context: {
      readonly environmentId: EnvironmentId;
      readonly teams: typeof Teams.Type;
      readonly folders: ReadonlyMap<string, string>;
      readonly key: string | undefined;
    },
  ) {
    if (!card.set) return "no-board" as const;
    const task = { board: card.set, id: card.id };
    const threadId = boardTaskThreadId(task);
    const folder = context.folders.get(card.set);
    const project =
      folder === undefined
        ? Option.none()
        : yield* local(projects.findActiveByWorkspaceRoot(folder));
    if (Option.isNone(project)) return "no-project" as const;
    const modelSelection = yield* leadSelection(
      context.teams.find((team) => team.team === card.team),
    );
    if (typeof modelSelection === "string") return modelSelection;
    // The command id is the task's, so a second start, a second server pass and a restart between
    // this create and the link below all answer with the one thread. The marker is stamped here
    // and by nothing later.
    yield* local(
      threads.dispatch({
        type: "thread.create",
        commandId: boardTaskThreadCommandId(task),
        threadId,
        projectId: project.value.projectId,
        title: card.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "system",
        creationSource: "server",
        engineIntake: boardTaskThreadMarker(task),
      }),
    );
    const created = yield* local(projections.getThreadRecords(threadId, []));
    const stamped = boardTaskOfMarker(created.thread.lineage.engineIntake);
    if (stamped?.board !== task.board || stamped.id !== task.id) return "foreign-thread" as const;
    if (context.key === undefined) return "no-key" as const;
    const put = yield* delivery
      .boardThreadAct({
        method: "PUT",
        path: `/api/tasks/${card.id}/board-thread`,
        body: {
          environmentId: context.environmentId,
          threadId,
          setBy: context.environmentId,
          // No link was set when the lanes were read. A writer in between is answered 409.
          expect: null,
          key: context.key,
        },
      })
      .pipe(Effect.result);
    if (put._tag === "Success") {
      yield* engine(decodeLinked(put.success.body));
      yield* holdClaim(card, context.environmentId, threadId);
      return null;
    }
    const refusal = refusalOf(put.failure);
    if (refusal.code === "conflict") {
      // Another writer set the link first. Its value stands and is never overwritten; the thread
      // made here holds no task, so it is archived, where the board still reaches it.
      const held = refusal.current;
      if (held?.environmentId === context.environmentId && held.threadId === threadId) {
        yield* holdClaim(card, context.environmentId, threadId);
        return null;
      }
      yield* archive(task, threadId, "displaced");
      return null;
    }
    if (refusal.code === "moved") {
      yield* archive(task, threadId, "moved");
      return "moved" as const;
    }
    if (refusal.code === "not-found") {
      yield* archive(task, threadId, "deleted");
      return null;
    }
    if (refusal.code === "refused") return "refused" as const;
    return yield* new BoardTaskThreadsError({ reason: "engine", cause: put.failure });
  });

  /**
   * The threads this server made whose task ended: deleted in the engine, or held by another
   * conversation now. They are archived, never deleted, and the board lists them.
   */
  const settleEnded = Effect.fn("BoardTaskThreads.settleEnded")(function* (
    cards: ReadonlyMap<string, Card>,
    environmentId: EnvironmentId,
  ) {
    for (const row of yield* local(rows.list({ archived: false }))) {
      const card = cards.get(row.task.id);
      if (card === undefined) {
        const read = yield* delivery
          .read({ path: `/api/tasks/${row.task.id}` })
          .pipe(Effect.result);
        if (read._tag === "Success" || read.failure.status !== 404) continue;
        yield* releaseClaim(row.task.id);
        yield* archive(row.task, row.threadId, "deleted");
        continue;
      }
      const link = card.boardThread;
      if (
        link !== null &&
        link !== undefined &&
        (link.environmentId !== environmentId || link.threadId !== row.threadId)
      ) {
        yield* releaseClaim(row.task.id);
        yield* archive(row.task, row.threadId, "displaced");
      }
    }
  });

  const reconcile = Effect.fn("BoardTaskThreads.reconcile")(
    function* () {
      const holds = new Map<string, BoardThreadHold>();
      const config = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
      if (config === null || !config.delivery.enabled) return holds;
      const environmentId = yield* identity.getEnvironmentId;
      const lanes = yield* engine(delivery.read({ path: LANES_PATH })).pipe(
        Effect.flatMap((response) => engine(decodeLanes(response.body))),
      );
      const cards = new Map(
        lanes.lanes.flatMap((lane) => lane.cards.map((card) => [card.id, card] as const)),
      );
      // An engine that serves no `boardThread` has no link to write to. Nothing is made for it.
      if ([...cards.values()].some((card) => card.boardThread === undefined)) return holds;
      const starting = [...cards.values()].filter(
        (card) =>
          card.boardThread === null &&
          !NOT_STARTED.has(card.lane) &&
          !FINISHED.has(card.lane) &&
          !MOVED.has(card.state),
      );
      if (starting.length > 0) {
        const teams = yield* engine(delivery.read({ path: "/api/teams" })).pipe(
          Effect.flatMap((response) => engine(decodeTeams(response.body))),
        );
        const folders = new Map(
          lanes.sets.flatMap((set) =>
            set.target?.path ? [[set.id, set.target.path] as const] : [],
          ),
        );
        const key = hostEnvironment[BOARD_THREAD_KEY_VARIABLE] || undefined;
        for (const card of starting) {
          const hold = yield* bind(card, { environmentId, teams, folders, key });
          if (hold !== null) holds.set(card.id, hold);
        }
      }
      for (const card of cards.values()) {
        const link = card.boardThread;
        if (link === null || link === undefined || link.environmentId !== environmentId) continue;
        if (NOT_STARTED.has(card.lane) || FINISHED.has(card.lane) || MOVED.has(card.state)) {
          yield* releaseClaim(card.id);
          continue;
        }
        yield* holdClaim(card, environmentId, link.threadId);
      }
      yield* settleEnded(cards, environmentId);
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
  return BoardTaskThreads.of({ reconcile, start });
});

export const layer = Layer.effect(BoardTaskThreads, make);
