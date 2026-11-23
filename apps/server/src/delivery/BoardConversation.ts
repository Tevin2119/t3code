// A board task's conversation, told to the engine (BOARD-REVAMP-UI-SPEC.md 6a, slice 5): a bounded
// mirror of its committed events for the card, and the steers the engine queued for it, delivered
// as native turns. The transcript stays here; the engine records facts only.
import {
  CommandId,
  MessageId,
  type DeliveryError,
  type EnvironmentId,
  type OrchestrationV2StoredEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { boardTaskOf, boardTaskThreadMarker, type BoardTask } from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";

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
}

const STEER_MESSAGE_PREFIX = "message:board-steer:";
const HANDOFF_NOTICE_PREFIX = "message:board-handoff:";

/** The message a queued steer is delivered as: one per steer, on every attempt. */
export const steerMessageId = (task: BoardTask, steerId: number) =>
  MessageId.make(`${STEER_MESSAGE_PREFIX}${task.board}:${task.id}:${steerId}`);
const steerCommandId = (task: BoardTask, steerId: number) =>
  CommandId.make(`${boardTaskThreadMarker(task)}:steer:${steerId}`);

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
      const steer =
        message.id.startsWith(STEER_MESSAGE_PREFIX) ||
        message.id.startsWith(HANDOFF_NOTICE_PREFIX) ||
        message.createdBy === "user";
      found.push({
        seq: stored.sequence,
        at: DateTime.formatIso(event.occurredAt),
        kind: steer ? "steer" : "message",
        excerpt: steer ? null : excerptOf(message.text),
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
      });
    }
  }
  return found;
}

/** The card fields this reads, as the engine's lanes carry them since slice 5. */
export interface ConversationCard {
  readonly id: string;
  readonly set?: string | null | undefined;
  readonly boardThread?:
    | { readonly environmentId: string; readonly threadId: string }
    | null
    | undefined;
  /** Absent on an engine before slice 5, which takes no ingest. */
  readonly conversation?: unknown;
  readonly steers?: { readonly pending: number } | null | undefined;
  readonly run?: { readonly id: string } | null | undefined;
  readonly hold?:
    | { readonly stage: string; readonly deadline: string; readonly handoff: "handed" | null }
    | null
    | undefined;
}

const Detail = Schema.Struct({
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
  }
>()("t3/delivery/BoardConversation") {}

export const make = Effect.gen(function* () {
  const delivery = yield* DeliveryService.DeliveryService;
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
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
    let sent = 0;
    for (const item of queued) {
      if (sent >= INGESTS_PER_PASS) break;
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
    for (const item of waiting) {
      const messageId = steerMessageId(task, item.id);
      const present = yield* projections.getMessagesById(threadId, [messageId]).pipe(Effect.result);
      if (present._tag === "Failure") return;
      // Delivered before, its confirmation lost: confirm it again, never send it twice.
      if (present.success.has(messageId)) {
        yield* settle(task.id, item.id, "delivered", context);
        continue;
      }
      const records = yield* projections
        .getThreadRecords(threadId, ["runs"], { runStatuses: [...ACTIVE_RUN_STATUSES] })
        .pipe(Effect.result);
      if (records._tag === "Failure") return;
      // An archived conversation is no live one: the steer stays pending, shown on the card.
      if (records.success.thread.archivedAt !== null || records.success.runs.length > 0) return;
      const sent = yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: steerCommandId(task, item.id),
          threadId,
          messageId,
          text: item.text,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
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
  ) {
    const entry = `${run}:qa:${deadline}`;
    const messageId = MessageId.make(`${HANDOFF_NOTICE_PREFIX}${task.board}:${task.id}:${entry}`);
    const present = yield* projections.getMessagesById(threadId, [messageId]).pipe(Effect.result);
    if (present._tag === "Failure" || present.success.has(messageId)) return;
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${boardTaskThreadMarker(task)}:handoff:${entry}`),
        threadId,
        messageId,
        text: `Run ${run} reached QA and the engine is holding it for your hand-off until ${deadline}. Call delivery_seat_handoff with stage "qa".`,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "system",
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
        if (steering && (card.steers?.pending ?? 0) > 0)
          yield* steer(task, threadId, context, detail);
        if (steering && card.hold?.stage === "qa" && card.hold.handoff === null && card.run?.id)
          yield* noticeHandoff(task, threadId, card.run.id, card.hold.deadline);
      }
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause(() =>
          Effect.logDebug("A board conversation pass did not finish; the next one carries on."),
        ),
      ),
  );

  return BoardConversation.of({ sync });
});

export const layer = Layer.effect(BoardConversation, make);
