import * as Schema from "effect/Schema";

import { BoardTaskBoardId } from "./boardThreadTasks.ts";
import { DeliveryReleaseChannel } from "./delivery.ts";

/**
 * What agents do with boards and tasks over MCP (`BoardAgentTools`): three tools whose `action`
 * picks one engine route. Fields the engine trims and caps itself carry no caps here, and lanes
 * are a plain string the engine checks, so the schemas agents read stay small.
 */

const Id = Schema.String.check(Schema.isPattern(/^[\w-]{1,100}$/));
const NonBlank = Schema.String.check(Schema.isNonEmpty(), Schema.isPattern(/\S/));

export const BOARD_AGENT_BULK_MAX = 200;

/** A dry run's token comes back with `confirm: true` to act on exactly what it showed. */
const Confirmation = {
  confirm: Schema.optional(Schema.Boolean),
  dryRunToken: Schema.optional(Schema.String),
};

export const BoardAgentBoard = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  icon: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
  base: Schema.NullOr(Schema.String),
  /** Deployment-linked, or bound to a protected repository: changing it needs `force`. */
  protected: Schema.Boolean,
});
export type BoardAgentBoard = typeof BoardAgentBoard.Type;

export const BoardAgentRepository = Schema.Struct({
  id: Schema.String,
  title: Schema.NullOr(Schema.String),
});

export const BoardAgentRun = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  stage: Schema.NullOr(Schema.String),
});

export const BoardAgentTaskSummary = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  lane: Schema.NullOr(Schema.String),
  board: Schema.NullOr(Schema.String),
  team: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.String),
  updated: Schema.NullOr(Schema.String),
  held: Schema.Boolean,
  run: Schema.NullOr(BoardAgentRun),
  /** A run is working: closing, discarding or re-boarding it needs `force`. */
  live: Schema.Boolean,
  protected: Schema.Boolean,
});
export type BoardAgentTaskSummary = typeof BoardAgentTaskSummary.Type;

export const BoardAgentTask = Schema.Struct({
  ...BoardAgentTaskSummary.fields,
  body: Schema.NullOr(Schema.String),
});
export type BoardAgentTask = typeof BoardAgentTask.Type;

/** Every field is checked here, not left to the engine. `query` is words or `#12`. */
export const BoardAgentTaskFilter = Schema.Struct({
  board: Schema.optional(BoardTaskBoardId),
  lane: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  origin: Schema.optional(Schema.String),
  updatedBefore: Schema.optional(Schema.String),
});
export type BoardAgentTaskFilter = typeof BoardAgentTaskFilter.Type;

/** `delivery_board`. */
export const BoardAgentBoardToolInput = Schema.Struct({
  action: Schema.Literals(["list", "create", "edit", "remove"]),
  board: Schema.optional(BoardTaskBoardId),
  title: Schema.optional(NonBlank),
  repository: Schema.optional(Id),
  base: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  force: Schema.optional(Schema.Boolean),
  ...Confirmation,
});
export type BoardAgentBoardToolInput = typeof BoardAgentBoardToolInput.Type;

export const BoardAgentBoardToolResult = Schema.Struct({
  boards: Schema.Array(BoardAgentBoard),
  repositories: Schema.optional(Schema.Array(BoardAgentRepository)),
  /** For remove: the board's tasks, kept on no board. */
  tasks: Schema.optional(Schema.Array(Schema.String)),
  /** Set on a remove's dry run; nothing was removed yet. */
  dryRunToken: Schema.optional(Schema.String),
  /** On a dry run: what to do with it. */
  next: Schema.optional(Schema.String),
});
export type BoardAgentBoardToolResult = typeof BoardAgentBoardToolResult.Type;

/** `delivery_task`. */
export const BoardAgentTaskToolInput = Schema.Struct({
  action: Schema.Literals(["get", "edit", "move", "submit", "close", "discard"]),
  task: Id,
  title: Schema.optional(NonBlank),
  body: Schema.optional(NonBlank),
  priority: Schema.optional(Schema.Literals(["low", "medium", "high", "urgent"])),
  tags: Schema.optional(Schema.Array(Schema.String)),
  lane: Schema.optional(Schema.String),
  board: Schema.optional(Schema.NullOr(BoardTaskBoardId)),
  base: Schema.optional(Schema.String),
  reason: Schema.optional(NonBlank),
  force: Schema.optional(Schema.Boolean),
  ...Confirmation,
});
export type BoardAgentTaskToolInput = typeof BoardAgentTaskToolInput.Type;

export const BoardAgentTaskToolResult = Schema.Struct({
  ...BoardAgentTask.fields,
  /** Set on a discard's dry run; nothing was changed yet. */
  dryRunToken: Schema.optional(Schema.String),
  /** On a dry run: what to do with it. */
  next: Schema.optional(Schema.String),
});
export type BoardAgentTaskToolResult = typeof BoardAgentTaskToolResult.Type;

/** `delivery_tasks`. */
export const BoardAgentTasksToolInput = Schema.Struct({
  action: Schema.Literals(["list", "close", "move"]),
  filter: Schema.optional(BoardAgentTaskFilter),
  tasks: Schema.optional(
    Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(BOARD_AGENT_BULK_MAX)),
  ),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  reason: Schema.optional(NonBlank),
  lane: Schema.optional(Schema.String),
  board: Schema.optional(Schema.NullOr(BoardTaskBoardId)),
  force: Schema.optional(Schema.Boolean),
  ...Confirmation,
});
export type BoardAgentTasksToolInput = typeof BoardAgentTasksToolInput.Type;

export const BoardAgentBulkItem = Schema.Struct({
  id: Schema.String,
  number: Schema.NullOr(Schema.Number),
  title: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["would-act", "done", "skipped", "failed", "not-found"]),
  message: Schema.NullOr(Schema.String),
});

export const BoardAgentTasksToolResult = Schema.Struct({
  tasks: Schema.optional(Schema.Array(BoardAgentTaskSummary)),
  /** More matches in this window: page with `filter.updatedBefore` set to the last `updated`. */
  more: Schema.Boolean,
  /**
   * The engine answered its newest 500 tasks: older ones are not reachable here. It has no
   * cursor, so paging ends at the window rather than claiming more.
   */
  truncated: Schema.Boolean,
  /** Set on a bulk dry run; pass it back with `confirm: true`. */
  dryRunToken: Schema.optional(Schema.String),
  /** On a dry run: what to do with it. */
  next: Schema.optional(Schema.String),
  items: Schema.optional(Schema.Array(BoardAgentBulkItem)),
});
export type BoardAgentTasksToolResult = typeof BoardAgentTasksToolResult.Type;

/** `delivery_engine_lifecycle`: what an agent may ask of the engine's launcher. */
export const DeliveryEngineLifecycleInput = Schema.Struct({
  action: Schema.Literals(["stop", "restart"]),
});
export type DeliveryEngineLifecycleInput = typeof DeliveryEngineLifecycleInput.Type;

/**
 * Every keyed engine control the Engine panel takes, sent with the approval key saved on the
 * server. The key never reaches the client, and refusals come back as fixed text.
 */
export const DeliveryEngineControlInput = Schema.Struct({
  action: Schema.Literals(["stop", "restart", "update", "later", "channel"]),
  commit: Schema.optional(Schema.String),
  channel: Schema.optional(DeliveryReleaseChannel),
});
export type DeliveryEngineControlInput = typeof DeliveryEngineControlInput.Type;

/**
 * What an engine control answers, and nothing else of the engine's answer: whether it was
 * accepted, and the receipt's id, commit and channel only in their fixed formats, so nothing the
 * engine echoes (such as the key it was sent) reaches a client or an agent.
 */
export const DeliveryEngineControlResult = Schema.Struct({
  ok: Schema.Literal(true),
  action: DeliveryEngineControlInput.fields.action,
  state: Schema.Literals(["accepted", "done"]),
  id: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
  channel: Schema.NullOr(DeliveryReleaseChannel),
});
export type DeliveryEngineControlResult = typeof DeliveryEngineControlResult.Type;
