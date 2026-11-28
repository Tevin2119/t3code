import * as Schema from "effect/Schema";

import { BoardTaskBoardId } from "./boardThreadTasks.ts";

/** What agents do with boards and tasks over MCP, one engine route each (`BoardAgentTools`). */

const Id = Schema.String.check(Schema.isPattern(/^[\w-]{1,100}$/));
const NonBlank = Schema.String.check(Schema.isNonEmpty(), Schema.isPattern(/\S/));
const Force = Schema.optional(
  Schema.Boolean.annotate({
    description:
      "Act on a task with a live run, or on a deployment-linked board. Only when the person asked.",
  }),
);

/** A board lane id, e.g. `queue`, `paused`, `completed`; the engine refuses others with the list. */
export const BoardAgentLane = Schema.String;
export type BoardAgentLane = typeof BoardAgentLane.Type;

export const BoardAgentBoard = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  icon: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
  base: Schema.NullOr(Schema.String),
  /** Linked to a deployment project: removing it, or closing its tasks, needs `force`. */
  deploymentLinked: Schema.Boolean,
});
export type BoardAgentBoard = typeof BoardAgentBoard.Type;

export const BoardAgentRepository = Schema.Struct({
  id: Schema.String,
  title: Schema.NullOr(Schema.String),
});

export const BoardAgentBoardsResult = Schema.Struct({
  boards: Schema.Array(BoardAgentBoard),
  /** What a board can be bound to; pass one's `id` as `repository`. */
  repositories: Schema.Array(BoardAgentRepository),
});
export type BoardAgentBoardsResult = typeof BoardAgentBoardsResult.Type;

export const BoardAgentBoardCreateInput = Schema.Struct({
  title: NonBlank,
  repository: Id.annotate({ description: "A repository `id` from `delivery_board` `list`." }),
  base: Schema.optional(
    Schema.String.annotate({ description: "Base branch. Omit for its default." }),
  ),
  description: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
});
export type BoardAgentBoardCreateInput = typeof BoardAgentBoardCreateInput.Type;

export const BoardAgentBoardEditInput = Schema.Struct({
  board: BoardTaskBoardId,
  title: Schema.optional(NonBlank),
  description: Schema.optional(Schema.String),
  repository: Schema.optional(Id),
  base: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
});
export type BoardAgentBoardEditInput = typeof BoardAgentBoardEditInput.Type;

export const BoardAgentBoardRemoveInput = Schema.Struct({ board: BoardTaskBoardId, force: Force });
export type BoardAgentBoardRemoveInput = typeof BoardAgentBoardRemoveInput.Type;

export const BoardAgentBoardRemoved = Schema.Struct({
  removed: Schema.String,
  /** The board's tasks, kept and now on no board. Recreate the board and move them back to undo. */
  tasks: Schema.Array(Schema.String),
  board: BoardAgentBoard,
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
  /** A run is working: closing, discarding or moving it needs `force`. */
  live: Schema.Boolean,
  deploymentLinked: Schema.Boolean,
});
export type BoardAgentTaskSummary = typeof BoardAgentTaskSummary.Type;

/** `query` is words or `#12`; `updatedBefore` an ISO time, to page past the newest. */
export const BoardAgentTaskFilter = Schema.Struct({
  board: Schema.optional(BoardTaskBoardId),
  lane: Schema.optional(BoardAgentLane),
  state: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  origin: Schema.optional(Schema.String),
  updatedBefore: Schema.optional(Schema.String),
});
export type BoardAgentTaskFilter = typeof BoardAgentTaskFilter.Type;

export const BoardAgentTasksListInput = Schema.Struct({
  ...BoardAgentTaskFilter.fields,
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })).annotate({
      description: "1 to 500; default 100. Newest first.",
    }),
  ),
});
export type BoardAgentTasksListInput = typeof BoardAgentTasksListInput.Type;

export const BoardAgentTasksListResult = Schema.Struct({
  tasks: Schema.Array(BoardAgentTaskSummary),
  /**
   * More may match. The engine has no cursor: page with `updatedBefore` set to the last
   * task's `updated`.
   */
  more: Schema.Boolean,
});
export type BoardAgentTasksListResult = typeof BoardAgentTasksListResult.Type;

export const BoardAgentTaskRef = Schema.Struct({ task: Id });
export type BoardAgentTaskRef = typeof BoardAgentTaskRef.Type;

export const BoardAgentTask = Schema.Struct({
  ...BoardAgentTaskSummary.fields,
  body: Schema.NullOr(Schema.String),
});
export type BoardAgentTask = typeof BoardAgentTask.Type;

export const BoardAgentTaskEditInput = Schema.Struct({
  task: Id,
  title: Schema.optional(NonBlank),
  body: Schema.optional(NonBlank.annotate({ description: "Drafts only." })),
  priority: Schema.optional(Schema.Literals(["low", "medium", "high", "urgent"])),
  tags: Schema.optional(Schema.Array(Schema.String)),
});
export type BoardAgentTaskEditInput = typeof BoardAgentTaskEditInput.Type;

export const BoardAgentTaskMoveInput = Schema.Struct({
  task: Id,
  lane: Schema.optional(BoardAgentLane),
  board: Schema.optional(
    Schema.NullOr(BoardTaskBoardId).annotate({ description: "A board id, or null for none." }),
  ),
  base: Schema.optional(
    Schema.String.annotate({
      description: "Base branch on the new board, when its repository differs.",
    }),
  ),
  force: Force,
});
export type BoardAgentTaskMoveInput = typeof BoardAgentTaskMoveInput.Type;

export const BoardAgentTaskCloseInput = Schema.Struct({
  task: Id,
  reason: NonBlank,
  force: Force,
});
export type BoardAgentTaskCloseInput = typeof BoardAgentTaskCloseInput.Type;

export const BoardAgentTaskDiscardInput = Schema.Struct({ task: Id, force: Force });
export type BoardAgentTaskDiscardInput = typeof BoardAgentTaskDiscardInput.Type;

export const BoardAgentTaskDiscarded = Schema.Struct({ discarded: Schema.String });

export const BOARD_AGENT_BULK_MAX = 200;

const BulkSelection = {
  tasks: Schema.optional(
    Schema.Array(Id)
      .check(Schema.isMinLength(1), Schema.isMaxLength(BOARD_AGENT_BULK_MAX))
      .annotate({ description: "Task ids. Or give `filter`." }),
  ),
  filter: Schema.optional(BoardAgentTaskFilter),
  force: Force,
  confirm: Schema.optional(
    Schema.Boolean.annotate({ description: "true acts; omit for the dry run." }),
  ),
  dryRunToken: Schema.optional(
    Schema.String.annotate({
      description: "From the dry run; required with `confirm`.",
    }),
  ),
};

export const BoardAgentBulkCloseInput = Schema.Struct({
  ...BulkSelection,
  reason: NonBlank,
});
export type BoardAgentBulkCloseInput = typeof BoardAgentBulkCloseInput.Type;

export const BoardAgentBulkMoveInput = Schema.Struct({
  ...BulkSelection,
  lane: Schema.optional(BoardAgentLane),
  board: BoardAgentTaskMoveInput.fields.board,
});
export type BoardAgentBulkMoveInput = typeof BoardAgentBulkMoveInput.Type;

export const BoardAgentBulkItem = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  outcome: Schema.Literals(["would-act", "done", "skipped", "failed"]),
  message: Schema.NullOr(Schema.String),
});

export const BoardAgentBulkResult = Schema.Struct({
  dryRun: Schema.Boolean,
  /** Pass back with `confirm: true` to act on exactly this list. */
  dryRunToken: Schema.NullOr(Schema.String),
  items: Schema.Array(BoardAgentBulkItem),
  /** More tasks match than one call takes. Call again after this batch. */
  more: Schema.Boolean,
});
export type BoardAgentBulkResult = typeof BoardAgentBulkResult.Type;

/** Stop or restart the engine through its launcher, with the approval key saved on the server. */
export const DeliveryEngineLifecycleInput = Schema.Struct({
  action: Schema.Literals(["stop", "restart"]),
});
export type DeliveryEngineLifecycleInput = typeof DeliveryEngineLifecycleInput.Type;

/** `delivery_board`: one tool, its action picks what the other fields mean. */
export const BoardAgentBoardToolInput = Schema.Struct({
  action: Schema.Literals(["list", "create", "edit", "remove"]),
  board: Schema.optional(BoardTaskBoardId),
  title: BoardAgentBoardEditInput.fields.title,
  repository: Schema.optional(Id),
  base: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  force: Schema.optional(Schema.Boolean),
});
export type BoardAgentBoardToolInput = typeof BoardAgentBoardToolInput.Type;

export const BoardAgentBoardToolResult = Schema.Struct({
  boards: Schema.Array(BoardAgentBoard),
  repositories: Schema.optional(Schema.Array(BoardAgentRepository)),
  /** After remove: the board's tasks, kept on no board. */
  tasks: Schema.optional(Schema.Array(Schema.String)),
});
export type BoardAgentBoardToolResult = typeof BoardAgentBoardToolResult.Type;

/** `delivery_task`: one task, one action. */
export const BoardAgentTaskToolInput = Schema.Struct({
  action: Schema.Literals(["get", "edit", "move", "submit", "close", "discard"]),
  task: Id,
  title: BoardAgentTaskEditInput.fields.title,
  body: Schema.optional(NonBlank),
  priority: BoardAgentTaskEditInput.fields.priority,
  tags: BoardAgentTaskEditInput.fields.tags,
  lane: Schema.optional(BoardAgentLane),
  board: Schema.optional(Schema.NullOr(BoardTaskBoardId)),
  base: Schema.optional(Schema.String),
  reason: Schema.optional(NonBlank),
  force: Schema.optional(Schema.Boolean),
});
export type BoardAgentTaskToolInput = typeof BoardAgentTaskToolInput.Type;

/** `delivery_tasks`: list, or close or move many after a dry run. */
export const BoardAgentTasksToolInput = Schema.Struct({
  action: Schema.Literals(["list", "close", "move"]),
  filter: Schema.optional(BoardAgentTaskFilter),
  tasks: Schema.optional(
    Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(BOARD_AGENT_BULK_MAX)),
  ),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  reason: Schema.optional(NonBlank),
  lane: Schema.optional(BoardAgentLane),
  board: Schema.optional(Schema.NullOr(BoardTaskBoardId)),
  force: Schema.optional(Schema.Boolean),
  confirm: Schema.optional(Schema.Boolean),
  dryRunToken: Schema.optional(Schema.String),
});
export type BoardAgentTasksToolInput = typeof BoardAgentTasksToolInput.Type;

export const BoardAgentTasksToolResult = Schema.Struct({
  tasks: Schema.optional(Schema.Array(BoardAgentTaskSummary)),
  more: Schema.Boolean,
  /** A dry run's token; pass it back with `confirm`. Null once acted. */
  dryRunToken: Schema.optional(Schema.NullOr(Schema.String)),
  items: Schema.optional(Schema.Array(BoardAgentBulkItem)),
});
export type BoardAgentTasksToolResult = typeof BoardAgentTasksToolResult.Type;
