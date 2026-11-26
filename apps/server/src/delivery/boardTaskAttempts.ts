// The engine's native attempts v2 (Operation-PaperClip #192): the model steps of a run on a board
// with "t3" execution, each run in the task's T3 thread. The engine stays the referee; these are
// the records T3 claims, attaches, and completes, and the ids that make each step replay-safe.
import {
  CommandId,
  MessageId,
  type OrchestrationV2EngineStageSeat,
  type OrchestrationV2Notification,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const NATIVE_ATTEMPT_KINDS = [
  "team-plan",
  "plan",
  "comment",
  "build",
  "review",
  "qa",
  "specialist",
  "checks",
] as const;

const Participant = Schema.Struct({
  seat: Schema.String,
  role: Schema.optional(Schema.NullOr(Schema.String)),
  harness: Schema.String,
  model: Schema.optional(Schema.NullOr(Schema.String)),
});

/** A v2 record as `GET /api/native-builds/:att` serves it. The list leaves out `prompt`. */
export const NativeAttempt = Schema.Struct({
  version: Schema.Literal(2),
  id: Schema.String,
  run: Schema.String,
  task: Schema.String,
  stage: Schema.String,
  kind: Schema.Literals(NATIVE_ATTEMPT_KINDS),
  seat: Schema.String,
  role: Schema.optional(Schema.NullOr(Schema.String)),
  lead: Schema.Boolean,
  access: Schema.Literals(["full", "read-only"]),
  participants: Schema.optional(Schema.Array(Participant)),
  worktree: Schema.String,
  harness: Schema.String,
  model: Schema.NullOr(Schema.String),
  prompt: Schema.optional(Schema.String),
  state: Schema.String,
  owner: Schema.NullOr(Schema.String),
  native: Schema.NullOr(
    Schema.Struct({
      environmentId: Schema.String,
      threadId: Schema.optional(Schema.String),
      runId: Schema.optional(Schema.NullOr(Schema.String)),
      childThreadId: Schema.optional(Schema.String),
    }),
  ),
  cancelRequested: Schema.Boolean,
});
export type NativeAttempt = typeof NativeAttempt.Type;

/** The v2 listing. An engine before #192 ignores `?version=2` and answers version 1. */
export const NativeAttemptList = Schema.Struct({
  version: Schema.Literal(2),
  pending: Schema.Array(Schema.Struct({ id: Schema.String })),
});

export const NATIVE_ATTEMPTS_PATH = "/api/native-builds?version=2";
export const nativeAttemptPath = (id: string) => `/api/native-builds/${encodeURIComponent(id)}`;

export const isTerminalAttempt = (state: string) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(state);

const BRIEF_PREFIX = "message:board-brief:";
const TURN_PREFIX = "message:board-attempt:";
const STAGE_PREFIX = "message:board-stage:";

/** The team plan's brief: the first message of the run, the only one that starts a team round. */
export const briefMessageId = (attemptId: string) => MessageId.make(`${BRIEF_PREFIX}${attemptId}`);
export const isBoardBriefMessageId = (id: string | null | undefined) =>
  typeof id === "string" && id.startsWith(BRIEF_PREFIX);

/** A lead attempt's turn of the task thread. */
export const leadTurnMessageId = (attemptId: string) =>
  MessageId.make(`${TURN_PREFIX}${attemptId}`);

/** The system turn that starts one batch of seats, named by its first attempt. */
export const stageMessageId = (firstAttemptId: string) =>
  MessageId.make(`${STAGE_PREFIX}${firstAttemptId}`);
export const isEngineStageMessageId = (id: string | null | undefined) =>
  typeof id === "string" && id.startsWith(STAGE_PREFIX);

/** One command per message, so a replay after any restart sends it once. */
export const turnCommandId = (messageId: MessageId) => CommandId.make(`${messageId}:dispatch`);

/** A seat's child: one per attempt, so its thread id is known before it starts. */
export const seatCommandId = (threadId: ThreadId, attemptId: string) =>
  CommandId.make(`board-stage:${threadId}:${attemptId}:seat`);

export const stopCommandId = (attemptId: string) =>
  CommandId.make(`board-attempt:${attemptId}:stop`);

/** What a batch's system turn carries: no team round, and the engine's seats to start. */
export const engineStageNotice = (
  stage: string,
  seats: ReadonlyArray<OrchestrationV2EngineStageSeat>,
): OrchestrationV2Notification => ({
  source: { kind: "engine_stage", stage, seats },
  outcome: "updated",
  summary: `Engine: ${seats.map((seat) => seat.seat).join(", ")} start${seats.length === 1 ? "s" : ""} ${stage}`,
});
