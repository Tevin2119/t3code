// A board task's conversation, told to the engine (BOARD-REVAMP-UI-SPEC.md 6a, slice 5): a bounded
// mirror of its committed events for the card, and the steers the engine queued for it, delivered
// as native turns. The transcript stays here; the engine records facts only.
import {
  CommandId,
  DeliverySeatModels,
  MessageId,
  type DeliveryError,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationV2Notification,
  type OrchestrationV2StoredEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { modelAccountFamily } from "@t3tools/shared/limitedSeat";
import { createModelSelection } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { boardTaskFinishedBy } from "@t3tools/shared/boardTaskFinished";
import { boardTaskInWork, MOVED } from "./boardTaskWork.ts";
import { boardTaskOf, boardTaskThreadMarker, type BoardTask } from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";
import { BoardLeadSeat, boardLeadSeat, resolveSeatProvider } from "./seatProvider.ts";

/** The engine's bound on an excerpt. Over it an ingest is refused whole. */
const EXCERPT_LIMIT = 200;
/** Ingests sent for one task in one pass, so a long history catches up over a few passes. */
const INGESTS_PER_PASS = 50;
/** Events read for one thread in one pass; a streamed reply is many of them. */
const EVENTS_PER_PASS = 2000;

type ActivityKind = "message" | "steer" | "summary";

/** One conversation event as the engine mirrors it. */
interface Activity {
  /** The event store's global sequence: durable, never reused, and higher on a newer thread. */
  readonly seq: number;
  readonly at: string;
  readonly kind: ActivityKind;
  readonly excerpt: string | null;
  /** A person's words typed in this conversation, told to the engine as its steer once. */
  readonly steer: { readonly messageId: string; readonly text: string } | null;
}

const STEER_MESSAGE_PREFIX = "message:board-steer:";
const HANDOFF_NOTICE_PREFIX = "message:board-handoff:";
const UNDELIVERED_NOTICE_PREFIX = "message:board-steer-undelivered:";
/** How long a thread steer the engine cannot take is tried: the board's default hand-off wait. */
const STEER_RETRY_MINUTES = 30;
const STEER_RETRY_MS = STEER_RETRY_MINUTES * 60 * 1000;

/** The message a queued steer is delivered as: one per steer, on every attempt. */
export const steerMessageId = (task: BoardTask, steerId: number) =>
  MessageId.make(`${STEER_MESSAGE_PREFIX}${task.board}:${task.id}:${steerId}`);
const steerCommandId = (task: BoardTask, steerId: number) =>
  CommandId.make(`${boardTaskThreadMarker(task)}:steer:${steerId}`);

/**
 * What every message the server sends into a board task's conversation carries: a system notice,
 * which the lead reads and which starts no team round (`NativeTeamChat.prepareTurn`).
 */
export const engineNotice = (summary: string, detail: string) =>
  ({
    source: { kind: "system" },
    outcome: "updated",
    summary,
    detail,
  }) satisfies OrchestrationV2Notification;

/** One line of at most the engine's bound, cut at a code point, never refused for its length. */
const excerptOf = (text: string): string | null => {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length === 0) return null;
  const points = [...line];
  return points.length <= EXCERPT_LIMIT ? line : `${points.slice(0, EXCERPT_LIMIT - 1).join("")}…`;
};

/** What a scan of one thread's events keeps, so the next scan reads only newer events. */
interface ScanState {
  through: number;
  readonly messages: Set<string>;
  readonly runs: Set<string>;
  readonly lastReply: Map<string, string>;
}

const emptyScan = (): ScanState => ({
  through: 0,
  messages: new Set(),
  runs: new Set(),
  lastReply: new Map(),
});

/**
 * The activities in a thread's committed events, oldest first. Each one's `seq` is the sequence of
 * the first event that makes it (a user message once it is complete, a run once it completes), so
 * rescanning the same events always names the same seqs. A person's words, typed here or queued on
 * the board, are a `steer` and carry no excerpt, keeping them off the card.
 */
function scanActivity(
  state: ScanState,
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
): ReadonlyArray<Activity> {
  const found: Array<Activity> = [];
  for (const stored of events) {
    if (stored.sequence <= state.through) continue;
    state.through = stored.sequence;
    const event = stored.event;
    if (event.type === "message.updated") {
      const message = event.payload;
      if (message.streaming) continue;
      if (message.role === "assistant") {
        if (message.runId !== null && message.text.trim())
          state.lastReply.set(message.runId, message.text);
        continue;
      }
      if (message.role !== "user" || state.messages.has(message.id)) continue;
      state.messages.add(message.id);
      const typed = message.createdBy === "user";
      const steer =
        message.id.startsWith(STEER_MESSAGE_PREFIX) ||
        message.id.startsWith(HANDOFF_NOTICE_PREFIX) ||
        message.id.startsWith(UNDELIVERED_NOTICE_PREFIX) ||
        typed;
      found.push({
        seq: stored.sequence,
        at: DateTime.formatIso(event.occurredAt),
        kind: steer ? "steer" : "message",
        excerpt: steer ? null : excerptOf(message.text),
        steer: typed && message.text.trim() ? { messageId: message.id, text: message.text } : null,
      });
      continue;
    }
    if (event.type === "run.updated" && event.payload.status === "completed") {
      const run = event.payload;
      if (state.runs.has(run.id)) continue;
      state.runs.add(run.id);
      const reply = state.lastReply.get(run.id);
      state.lastReply.delete(run.id);
      if (reply === undefined) continue;
      found.push({
        seq: stored.sequence,
        at: DateTime.formatIso(event.occurredAt),
        kind: "summary",
        excerpt: excerptOf(reply),
        steer: null,
      });
    }
  }
  return found;
}

/** The card fields this reads, as the engine's lanes carry them since slice 5. */
export interface ConversationCard {
  readonly id: string;
  readonly state?: string | undefined;
  readonly lane?: string | null | undefined;
  readonly set?: string | null | undefined;
  readonly boardThread?:
    | { readonly environmentId: string; readonly threadId: string }
    | null
    | undefined;
  /** Absent on an engine before slice 5, which takes no ingest. */
  readonly conversation?: unknown;
  readonly steers?: { readonly pending: number } | null | undefined;
  readonly run?: { readonly id: string } | null | undefined;
  readonly seatModels?: typeof DeliverySeatModels.Type;
  readonly hold?:
    | { readonly stage: string; readonly deadline: string; readonly handoff: "handed" | null }
    | null
    | undefined;
}

const Detail = Schema.Struct({
  state: Schema.optional(Schema.String),
  lane: Schema.optional(Schema.NullOr(Schema.String)),
  seatModels: DeliverySeatModels,
  roster: Schema.optional(Schema.Array(BoardLeadSeat)),
  conversation: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        // The marker of an engine that scopes activity to its source (spec 6a amendment): this
        // server's resume floor is its own entry in `sourceFloors`. An older engine serves neither.
        sourceScoped: Schema.optional(Schema.Boolean),
        sourceFloors: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
        latest: Schema.optional(
          Schema.Array(Schema.Struct({ seq: Schema.Number, setBy: Schema.String })),
        ),
      }),
    ),
  ),
  steers: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.Number, text: Schema.String, state: Schema.String })),
  ),
});
const decodeDetail = Schema.decodeUnknownOption(Detail);
const decodeCode = Schema.decodeUnknownOption(
  Schema.Struct({ code: Schema.optional(Schema.String) }),
);
const codeOf = (error: DeliveryError) => {
  const decoded = decodeCode(error.body);
  return Option.isSome(decoded) ? (decoded.value.code ?? null) : null;
};

/** Thread steers this server has told, kept across restarts; the oldest are forgotten past it. */
const STEERED_KEPT = 2000;
/** A notice owed to the thread for a person's words that never reached the team. */
const OwedNotice = Schema.Struct({
  board: Schema.String,
  task: Schema.String,
  threadId: Schema.String,
  messageId: Schema.String,
  quoted: Schema.String,
  reason: Schema.String,
});
type OwedNotice = typeof OwedNotice.Type;
/** A person's words seen in a task's conversation and not yet settled as a steer. */
const PendingSteer = Schema.Struct({
  board: Schema.String,
  task: Schema.String,
  threadId: Schema.String,
  messageId: Schema.String,
  text: Schema.String,
  typedAt: Schema.String,
});
type PendingSteer = typeof PendingSteer.Type;
const SteeredFile = Schema.fromJsonString(
  Schema.Struct({
    steered: Schema.Array(Schema.String),
    pending: Schema.optional(Schema.Record(Schema.String, PendingSteer)),
    owed: Schema.optional(Schema.Record(Schema.String, OwedNotice)),
  }),
);

/** Where a task stands for its steers, from its card or, off the lanes, its own detail. */
export type SteerStanding =
  | {
      readonly state: string;
      readonly lane?: string | null | undefined;
      readonly split?: boolean | null | undefined;
      readonly boardThread?:
        | { readonly environmentId: string; readonly threadId: string }
        | null
        | undefined;
    }
  | "deleted";
const decodeSteered = Schema.decodeUnknownOption(SteeredFile);
const encodeSteered = Schema.encodeEffect(SteeredFile);

const ACTIVE_RUN_STATUSES = ["preparing", "queued", "starting", "running", "waiting"] as const;

/** Refusals that never pass: the steer is told failed. Any other failure is tried next pass. */
const FINAL_REFUSALS = new Set([
  "OrchestratorCommandRejectedError",
  "OrchestratorCommandPreviouslyRejectedError",
  "OrchestratorSubagentThreadReadOnlyError",
  "OrchestratorThreadHandedOnError",
]);

export class BoardConversation extends Context.Service<
  BoardConversation,
  {
    /**
     * One pass over the tasks whose conversation this server holds: mirrors new activity and
     * delivers pending steers. `steering` names the tasks in work, the only ones a steer reaches.
     * Never fails: what does not go through now is tried on the next pass.
     */
    readonly sync: (input: {
      readonly cards: ReadonlyArray<ConversationCard>;
      readonly steering: ReadonlySet<string>;
      readonly environmentId: EnvironmentId;
      readonly key: string;
    }) => Effect.Effect<void>;
    /**
     * Settles the steer ledger, every pass and for every thread whatever its task's card says:
     * owed notices are posted, and each pending steer is told, retried within its window, or
     * given up with a notice owed. `standings` holds every task the lanes or a detail read show;
     * a task not in it is unknown, and its steers wait out their window.
     */
    readonly settleSteers: (input: {
      readonly standings: ReadonlyMap<string, SteerStanding>;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<void>;
  }
>()("t3/delivery/BoardConversation") {}

export const make = Effect.gen(function* () {
  const delivery = yield* DeliveryService.DeliveryService;
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  // The engine's steer route takes no key to dedupe on, so which person's words were told is
  // kept here: a mirror lost after its steer, then a restart, must not tell them twice.
  const steeredPath = path.join(config.stateDir, "delivery-thread-steers.json");
  const saved = yield* fileSystem.readFileString(steeredPath).pipe(
    Effect.map((text) => decodeSteered(text)),
    Effect.orElseSucceed(() => Option.none()),
  );
  const steered = new Set(Option.isSome(saved) ? saved.value.steered : []);
  // Saved before the words are mirrored, so a steer is settled whatever happens to the scan.
  const pendingSteers = new Map(
    Object.entries(Option.isSome(saved) ? (saved.value.pending ?? {}) : {}),
  );
  // Kept until posted: the steer is settled first, so a notice never sends the steer again.
  const owed = new Map(Object.entries(Option.isSome(saved) ? (saved.value.owed ?? {}) : {}));
  const saveSteers = Effect.fn("BoardConversation.saveSteers")(function* () {
    for (const old of steered) {
      if (steered.size <= STEERED_KEPT) break;
      steered.delete(old);
    }
    return yield* encodeSteered({
      steered: [...steered],
      pending: Object.fromEntries(pendingSteers),
      owed: Object.fromEntries(owed),
    }).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: steeredPath, contents })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("Which thread steers were told could not be saved.", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );
  });
  // Kept in memory: after a restart each task starts again from the engine's highest seq.
  const scans = new Map<string, ScanState>();
  const floors = new Map<string, number>();
  const pending = new Map<string, ReadonlyArray<Activity>>();

  const detailOf = (taskId: string) =>
    delivery.read({ path: `/api/tasks/${taskId}` }).pipe(
      Effect.map((response) => decodeDetail(response.body)),
      Effect.orElseSucceed(() => Option.none()),
    );

  const post = (path: string, body: unknown) =>
    delivery.boardThreadAct({ method: "POST", path, body }).pipe(Effect.result);

  const turnSelection = Effect.fn("BoardConversation.turnSelection")(function* (
    detail: typeof Detail.Type,
    current: ModelSelection,
  ) {
    const lead = boardLeadSeat(detail.roster ?? []);
    const published = lead === undefined ? undefined : detail.seatModels?.[lead.seat];
    // No pick, one this build cannot read, or a lead picked only when it runs: the thread keeps
    // the model it has.
    if (!published || published.model === null) return undefined;
    const providers = yield* instances.listInstances;
    const existing = providers.find((provider) => provider.instanceId === current.instanceId);
    const next = resolveSeatProvider(
      providers.filter((provider) => provider.enabled),
      published.harness,
      (provider) => provider.instanceId,
      current.instanceId,
    );
    if (
      typeof next === "string" ||
      modelAccountFamily(existing?.driverKind, current.model) !==
        modelAccountFamily(next.driverKind, published.model)
    )
      return undefined;
    return next.instanceId === current.instanceId && published.model === current.model
      ? current
      : createModelSelection(next.instanceId, published.model);
  });

  /**
   * Posts every owed notice. One that cannot be posted now stays owed and is tried on the next
   * pass; only a refusal that never passes drops it, which is logged.
   */
  const postOwedNotices = Effect.fn("BoardConversation.postOwedNotices")(function* () {
    for (const [key, notice] of owed) {
      const posted = yield* noticeUndelivered(notice);
      if (posted === "later") continue;
      if (posted === "refused")
        yield* Effect.logWarning("A notice of an undelivered message could not be posted.", {
          task: notice.task,
          message: notice.messageId,
        });
      owed.delete(key);
      yield* saveSteers();
    }
  });

  const noticeUndelivered = Effect.fn("BoardConversation.noticeUndelivered")(function* (
    notice: OwedNotice,
  ) {
    const task = boardTaskOf(notice.board, notice.task);
    if (task === null) return "refused" as const;
    const threadId = notice.threadId as ThreadId;
    const messageId = MessageId.make(
      `${UNDELIVERED_NOTICE_PREFIX}${task.board}:${task.id}:${notice.messageId}`,
    );
    const present = yield* projections.getMessagesById(threadId, [messageId]).pipe(Effect.result);
    if (present._tag === "Failure") return "later" as const;
    if (present.success.has(messageId)) return "posted" as const;
    const text = `This message didn't reach the team: ${notice.reason}. Send it again when the task is running.\n\n> ${notice.quoted}`;
    const sent = yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${boardTaskThreadMarker(task)}:undelivered:${notice.messageId}`),
        threadId,
        messageId,
        text,
        notification: engineNotice("A message didn't reach the team", text),
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.result);
    if (sent._tag === "Success") return "posted" as const;
    return FINAL_REFUSALS.has(sent.failure._tag) ? ("refused" as const) : ("later" as const);
  });

  /** Settles a steer that never reached the team, and owes the thread a notice of it. */
  const giveUp = (key: string, steer: PendingSteer, reason: string) => {
    pendingSteers.delete(key);
    steered.add(key);
    owed.set(key, {
      board: steer.board,
      task: steer.task,
      threadId: steer.threadId,
      messageId: steer.messageId,
      quoted: excerptOf(steer.text)?.slice(0, 80) ?? "",
      reason,
    });
  };

  /** Why a task cannot take a steer from this thread now, or `null` when it can. */
  const steerRefusedBy = (standing: SteerStanding, steer: PendingSteer, environmentId: string) => {
    if (standing === "deleted") return "the task was deleted";
    if (MOVED.has(standing.state)) return "the task moved to another machine";
    const link = standing.boardThread;
    if (link?.environmentId !== environmentId || link.threadId !== steer.threadId)
      return "this conversation no longer holds the task";
    return boardTaskInWork(standing) ? null : "the task is no longer in work";
  };

  const settleSteers = Effect.fn("BoardConversation.settleSteers")(
    function* (input: {
      readonly standings: ReadonlyMap<string, SteerStanding>;
      readonly environmentId: EnvironmentId;
    }) {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const expired = `the engine could not take it for ${STEER_RETRY_MINUTES} minutes`;
      for (const [key, steer] of pendingSteers) {
        if (steered.has(key)) {
          pendingSteers.delete(key);
          continue;
        }
        const late = now - Date.parse(steer.typedAt) >= STEER_RETRY_MS;
        const standing = input.standings.get(steer.task);
        const refused =
          standing === undefined ? null : steerRefusedBy(standing, steer, input.environmentId);
        // Stale words never reach a live run; unknown ones wait out their window.
        if (late && refused === null) {
          giveUp(key, steer, expired);
          continue;
        }
        if (standing === undefined) continue;
        // Told once more even when refused: one the engine took before a crash settles as taken.
        const told = yield* post(`/api/tasks/${steer.task}/steer`, {
          text: steer.text,
          by: "person",
          from: "thread",
          // Stable per message: the engine applies a steer once per `ref`, so a retry is safe.
          ref: `thread:${steer.threadId}:${steer.messageId}`,
        });
        if (told._tag === "Success") {
          pendingSteers.delete(key);
          steered.add(key);
          continue;
        }
        const status = told.failure.status;
        if (refused !== null) giveUp(key, steer, refused);
        else if (status !== undefined && status < 500)
          giveUp(key, steer, told.failure.detail.replace(/\s+/g, " ").slice(0, 200));
      }
      if (!(yield* saveSteers())) return;
      yield* postOwedNotices();
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause(() =>
          Effect.logDebug("Thread steers were not settled; the next pass carries on."),
        ),
      ),
  );

  const mirror = Effect.fn("BoardConversation.mirror")(function* (
    card: ConversationCard,
    threadId: ThreadId,
    context: { readonly environmentId: EnvironmentId; readonly key: string },
    detail: () => Effect.Effect<Option.Option<typeof Detail.Type>>,
  ) {
    const scanKey = `${card.id}\u0000${threadId}`;
    let floor = floors.get(scanKey);
    if (floor === undefined) {
      if (card.conversation === null) floor = -1;
      else {
        const read = yield* detail();
        if (Option.isNone(read)) return;
        const mirrored = read.value.conversation;
        if (mirrored?.sourceScoped === true && mirrored.sourceFloors !== undefined) {
          // No entry is no floor: the first eligible item goes.
          floor = mirrored.sourceFloors[context.environmentId] ?? -1;
        } else {
          // An engine before the amendment orders by one seq across sources, so another
          // environment's latest row is a floor this server's seqs cannot be compared with.
          const latest = mirrored?.latest?.[0];
          if (latest && latest.setBy !== context.environmentId) return;
          floor = latest?.seq ?? -1;
        }
      }
      floors.set(scanKey, floor);
    }
    const scan = scans.get(scanKey) ?? emptyScan();
    scans.set(scanKey, scan);
    const read = yield* events
      .read({ threadId, afterSequence: scan.through, limit: EVENTS_PER_PASS })
      .pipe(Stream.runCollect, Effect.result);
    if (read._tag === "Failure") return;
    const known = floor;
    const queued = [
      ...(pending.get(scanKey) ?? []),
      ...scanActivity(scan, read.success).filter((item) => item.seq > known),
    ];
    const task = card.set ? boardTaskOf(card.set, card.id) : null;
    let sent = 0;
    for (const [index, item] of queued.entries()) {
      if (sent >= INGESTS_PER_PASS) break;
      // Saved to the steer ledger before the item is mirrored; `settleSteers` tells it.
      if (item.steer !== null) {
        const key = `${threadId}\u0000${item.steer.messageId}`;
        if (task && !steered.has(key) && !pendingSteers.has(key)) {
          pendingSteers.set(key, {
            board: task.board,
            task: task.id,
            threadId,
            messageId: item.steer.messageId,
            text: item.steer.text,
            typedAt: item.at,
          });
          // Never mirrored unsaved: the mirror stops here and sees it again next pass.
          if (!(yield* saveSteers())) {
            pendingSteers.delete(key);
            break;
          }
        }
        queued[index] = { ...item, steer: null };
      }
      const answer = yield* post(`/api/tasks/${card.id}/activity`, {
        at: item.at,
        kind: item.kind,
        ...(item.excerpt === null ? {} : { excerpt: item.excerpt }),
        seq: item.seq,
        setBy: context.environmentId,
        key: context.key,
      });
      if (answer._tag === "Failure") {
        const code = codeOf(answer.failure);
        if (code !== "invalid-field" && code !== "not-found" && code !== "moved") break;
      }
      sent += 1;
    }
    pending.set(scanKey, queued.slice(sent));
  });

  /** Delivered once the message is in the conversation; a repeat confirmation is a no-op. */
  const settle = (
    taskId: string,
    steerId: number,
    how: "delivered" | "failed",
    context: { readonly environmentId: EnvironmentId; readonly key: string },
    reason?: string,
  ) =>
    post(`/api/tasks/${taskId}/steers/${steerId}/${how}`, {
      setBy: context.environmentId,
      key: context.key,
      ...(reason === undefined ? {} : { reason }),
    }).pipe(
      Effect.tap((answer) =>
        answer._tag === "Failure" && codeOf(answer.failure) !== "conflict"
          ? Effect.logDebug("A board steer's confirmation is sent again next pass.", {
              task: taskId,
              steer: steerId,
            })
          : Effect.void,
      ),
    );

  /**
   * The oldest pending steer, delivered at a turn boundary: only when the conversation has no
   * active or queued run, and never by interrupting one. One per pass, so each is its own turn.
   */
  const steer = Effect.fn("BoardConversation.steer")(function* (
    task: BoardTask,
    threadId: ThreadId,
    context: { readonly environmentId: EnvironmentId; readonly key: string },
    detail: () => Effect.Effect<Option.Option<typeof Detail.Type>>,
  ) {
    const read = yield* detail();
    if (Option.isNone(read)) return;
    const waiting = (read.value.steers ?? [])
      .filter((item) => item.state === "pending")
      .toSorted((a, b) => a.id - b.id);
    const { state, lane } = read.value;
    // The pass chose this task from an older lanes read; the task may have closed since.
    const finishedBy = state === undefined ? null : boardTaskFinishedBy({ state, lane });
    for (const item of waiting) {
      const messageId = steerMessageId(task, item.id);
      const present = yield* projections.getMessagesById(threadId, [messageId]).pipe(Effect.result);
      if (present._tag === "Failure") return;
      // Delivered before, its confirmation lost: confirm it again, never send it twice.
      if (present.success.has(messageId)) {
        yield* settle(task.id, item.id, "delivered", context);
        continue;
      }
      if (finishedBy !== null) {
        yield* settle(
          task.id,
          item.id,
          "failed",
          context,
          finishedBy === "closed-not-done" ? "The task was closed." : `The task is ${finishedBy}.`,
        );
        continue;
      }
      const records = yield* projections
        .getThreadRecords(threadId, ["runs"], { runStatuses: [...ACTIVE_RUN_STATUSES] })
        .pipe(Effect.result);
      if (records._tag === "Failure") return;
      // An archived conversation is no live one: the steer stays pending, shown on the card.
      if (records.success.thread.archivedAt !== null || records.success.runs.length > 0) return;
      const modelSelection = yield* turnSelection(
        read.value,
        records.success.thread.modelSelection,
      );
      const sent = yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: steerCommandId(task, item.id),
          threadId,
          messageId,
          text: item.text,
          notification: engineNotice("A steer from the board", item.text),
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.result);
      if (sent._tag === "Success") {
        yield* settle(task.id, item.id, "delivered", context);
      } else if (FINAL_REFUSALS.has(sent.failure._tag)) {
        yield* settle(task.id, item.id, "failed", context, sent.failure.message);
        continue;
      }
      return;
    }
  });

  const noticeHandoff = Effect.fn("BoardConversation.noticeHandoff")(function* (
    task: BoardTask,
    threadId: ThreadId,
    run: string,
    deadline: string,
    detail: (() => Effect.Effect<Option.Option<typeof Detail.Type>>) | undefined,
  ) {
    const entry = `${run}:qa:${deadline}`;
    const messageId = MessageId.make(`${HANDOFF_NOTICE_PREFIX}${task.board}:${task.id}:${entry}`);
    const present = yield* projections.getMessagesById(threadId, [messageId]).pipe(Effect.result);
    if (present._tag === "Failure" || present.success.has(messageId)) return;
    let modelSelection: ModelSelection | undefined;
    if (detail !== undefined) {
      const read = yield* detail();
      if (Option.isSome(read)) {
        const shell = yield* projections.getThreadShell(threadId).pipe(Effect.result);
        if (shell._tag === "Failure" || shell.success === null || shell.success.archivedAt !== null)
          return;
        modelSelection = yield* turnSelection(read.value, shell.success.modelSelection);
      }
    }
    const text = `Run ${run} reached QA and the engine is holding it for your hand-off until ${deadline}. Call delivery_seat_handoff with stage "qa".`;
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${boardTaskThreadMarker(task)}:handoff:${entry}`),
        threadId,
        messageId,
        text,
        notification: engineNotice("The engine is holding QA for your hand-off", text),
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.ignore);
  });

  const sync = Effect.fn("BoardConversation.sync")(
    function* (input: {
      readonly cards: ReadonlyArray<ConversationCard>;
      readonly steering: ReadonlySet<string>;
      readonly environmentId: EnvironmentId;
      readonly key: string;
    }) {
      const context = { environmentId: input.environmentId, key: input.key };
      for (const card of input.cards) {
        const link = card.boardThread;
        if (!link || link.environmentId !== input.environmentId || !card.set) continue;
        // An engine before slice 5 serves neither, and takes no ingest or confirmation.
        if (card.conversation === undefined) continue;
        const task = boardTaskOf(card.set, card.id);
        if (task === null) continue;
        const threadId = link.threadId as ThreadId;
        let read: Option.Option<typeof Detail.Type> | undefined;
        // One detail read per task and pass, shared by the mirror's first pass and the steers.
        const detail = () =>
          read === undefined
            ? detailOf(card.id).pipe(Effect.tap((value) => Effect.sync(() => (read = value))))
            : Effect.succeed(read);
        const steering = input.steering.has(card.id);
        // A finished task's conversation is followed only if this server already followed it.
        if (steering || floors.has(`${card.id}\u0000${threadId}`))
          yield* mirror(card, threadId, context, detail);
        // A finished task is no longer steered, but a steer left pending on it is still settled.
        const finished =
          card.state !== undefined &&
          boardTaskFinishedBy({ state: card.state, lane: card.lane }) !== null;
        if ((steering || finished) && (card.steers?.pending ?? 0) > 0)
          yield* steer(task, threadId, context, detail);
        if (steering && card.hold?.stage === "qa" && card.hold.handoff === null && card.run?.id)
          yield* noticeHandoff(
            task,
            threadId,
            card.run.id,
            card.hold.deadline,
            card.seatModels === undefined ? undefined : detail,
          );
      }
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause(() =>
          Effect.logDebug("A board conversation pass did not finish; the next one carries on."),
        ),
      ),
  );

  return BoardConversation.of({ sync, settleSteers });
});

export const layer = Layer.effect(BoardConversation, make);
