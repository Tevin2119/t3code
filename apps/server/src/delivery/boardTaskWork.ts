// Whether the engine is working a board task, read from its lane and state. Both the board pass
// and the lead hand-off decide by it, the hand-off from its own read of the task.
import { boardTaskFinishedBy } from "@t3tools/shared/boardTaskFinished";

// A task in one of these lanes has not started or is not a task run: it has no conversation yet.
// `intake` and `ready` are what an engine before the queue lane calls the same wait.
const NOT_STARTED = new Set(["draft", "chat", "queue", "intake", "ready"]);
// A task that moved is worked on another machine; the engine refuses its link here (`moved`).
export const MOVED = new Set(["moved", "moving"]);

interface TaskStanding {
  readonly lane?: string | null | undefined;
  readonly state: string;
}

/** A task in work: it holds a conversation and a claim. A split parent's parts are its work. */
export const boardTaskInWork = (task: TaskStanding) =>
  !NOT_STARTED.has(task.lane ?? "") &&
  boardTaskFinishedBy(task) === null &&
  !MOVED.has(task.state) &&
  task.state !== "split";
