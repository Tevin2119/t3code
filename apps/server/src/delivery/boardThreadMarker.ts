import { CommandId, ThreadId } from "@t3tools/contracts";

export interface BoardTask {
  readonly board: string;
  readonly id: string;
}

const PREFIX = "board-task:";

// Each id is percent-encoded, so the colon that separates them can never come from an id: board
// `a:b` with task `c` and board `a` with task `b:c` are two markers. An id of letters, digits,
// `-` and `_` is spelled as it is, so the markers written before this grammar still read.
const part = (value: string) => encodeURIComponent(value);

/**
 * The lineage marker of a board task's conversation: it keeps the thread out of every list. It is
 * stamped when the thread is created and never after. The engine holds a task's thread
 * (`boardThread`); the marker only says which task a thread was made for.
 */
export const boardTaskThreadMarker = (task: BoardTask) =>
  `${PREFIX}${part(task.board)}:${part(task.id)}`;

/** One create command per task, so starting a task twice makes one thread. */
export const boardTaskThreadCommandId = (task: BoardTask) =>
  CommandId.make(`${boardTaskThreadMarker(task)}:thread`);

/** The thread a task's conversation is created as: one id per task, on every start. */
export const boardTaskThreadId = (task: BoardTask) => ThreadId.make(boardTaskThreadMarker(task));

/** Matches every board task marker in SQL `LIKE`, and nothing an engine intake stamps. */
export const BOARD_TASK_MARKER_LIKE = `${PREFIX}%`;

/**
 * Thread to task, and never the other way: the task a marker was stamped for, or null for a value
 * that is no board task marker (an engine intake's admission, or a spelling this grammar does not
 * write). A task's thread is read from the engine, never found by building a marker.
 */
export function boardTaskOfMarker(marker: string | null | undefined): BoardTask | null {
  if (typeof marker !== "string" || !marker.startsWith(PREFIX)) return null;
  const parts = marker.slice(PREFIX.length).split(":");
  if (parts.length !== 2) return null;
  try {
    const [board, id] = parts.map((value) => decodeURIComponent(value)) as [string, string];
    if (board === "" || id === "") return null;
    // Only the spelling the grammar writes resolves, so no two markers name one task.
    return boardTaskThreadMarker({ board, id }) === marker ? { board, id } : null;
  } catch {
    return null;
  }
}
