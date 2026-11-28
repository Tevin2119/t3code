import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";

declare const BoardTaskBrand: unique symbol;

/** A board and one of its tasks, with ids the marker can carry. Made only by `boardTaskOf`. */
export interface BoardTask {
  readonly board: string;
  readonly id: string;
  readonly [BoardTaskBrand]: true;
}

const PREFIX = "board-task:";

// The pin covers the two ids T3 writes into the marker and nothing else. A task id is what the
// engine's routes take (`[\w-]+`); a board id has no colon, whitespace or control character, so
// the colon between them is never an id's and the marker is a thread id the engine accepts.
const BOARD_ID = /^[^\s\p{C}:]{1,256}$/u;
const TASK_ID = /^[\w-]{1,256}$/;

/**
 * The task a marker may be written for, or null for ids it cannot carry. An id with a colon is
 * refused here, at write, and never escaped: such a task gets no thread and no link.
 */
export const boardTaskOf = (board: string, id: string): BoardTask | null =>
  BOARD_ID.test(board) && TASK_ID.test(id) ? ({ board, id } as BoardTask) : null;

/**
 * The lineage marker of a board task's conversation: it keeps the thread out of every list. It is
 * stamped when the thread is created and never after. The engine holds a task's thread
 * (`boardThread`); the marker only says which task a thread was made for.
 */
export const boardTaskThreadMarker = (task: BoardTask) => `${PREFIX}${task.board}:${task.id}`;

/** One create command per task, so starting a task twice makes one thread. */
export const boardTaskThreadCommandId = (task: BoardTask) =>
  CommandId.make(`${boardTaskThreadMarker(task)}:thread`);

/** The thread a task's conversation is created as: one id per task, on every start. */
export const boardTaskThreadId = (task: BoardTask) => ThreadId.make(boardTaskThreadMarker(task));

export const createBoardTaskThread = (
  task: BoardTask,
  input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
  },
) =>
  ({
    ...input,
    type: "thread.create",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "system",
    creationSource: "server",
    engineIntake: boardTaskThreadMarker(task),
  }) satisfies OrchestrationV2ServerCommand;

/** Whether a thread was created as a board task's conversation, from its id alone. */
export const isBoardTaskThreadId = (threadId: string) =>
  threadId.startsWith(PREFIX) && boardTaskOfMarker(threadId) !== null;

/** Matches every board task marker in SQL `LIKE`, and nothing an engine intake stamps. */
export const BOARD_TASK_MARKER_LIKE = `${PREFIX}%`;

/**
 * Thread to task, and never the other way: the task a marker was stamped for, or null for a value
 * that is no board task marker (an engine intake's admission, an empty id, a colon in an id). A
 * task's thread is read from the engine, never found by building a marker.
 */
export function boardTaskOfMarker(marker: string | null | undefined): BoardTask | null {
  if (typeof marker !== "string" || !marker.startsWith(PREFIX)) return null;
  const [board, id, ...more] = marker.slice(PREFIX.length).split(":");
  return board === undefined || id === undefined || more.length > 0 ? null : boardTaskOf(board, id);
}
