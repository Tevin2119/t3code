import { CommandId } from "@t3tools/contracts";

interface BoardTask {
  readonly board: string;
  readonly id: string;
}

/**
 * The lineage marker of a board task's conversation: it keeps the thread out of every list. One
 * way only. The engine holds a task's thread, and nothing reads a task back out of a marker.
 */
export const boardTaskThreadMarker = (task: BoardTask) => `board-task:${task.board}:${task.id}`;

/** One create command per task, so starting a task twice makes one thread. */
export const boardTaskThreadCommandId = (task: BoardTask) =>
  CommandId.make(`${boardTaskThreadMarker(task)}:thread`);
