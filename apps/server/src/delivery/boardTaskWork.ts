// Whether the engine is working a board task, read from its lane and state. Both the board pass
// and the lead hand-off decide by it, the hand-off from its own read of the task.

// A task in one of these lanes has not started or is not a task run: it has no conversation yet.
// `intake` and `ready` are what an engine before the queue lane calls the same wait.
const NOT_STARTED = new Set(["draft", "chat", "queue", "intake", "ready"]);
// Finished work keeps the conversation it had and is given none anew.
const FINISHED = new Set(["completed", "closed-not-done"]);
// The engine's closed states, which it never claims ("finished work is not claimed"). An approved
// or open-PR task keeps its lane, and its thread stays linked.
const FINISHED_STATES = new Set(["approved", "pr-open", "merged", "rejected", "closed"]);
// A task that moved is worked on another machine; the engine refuses its link here (`moved`).
export const MOVED = new Set(["moved", "moving"]);

/** A task in work: it holds a conversation and a claim. A split parent's parts are its work. */
export const boardTaskInWork = (task: {
  readonly lane?: string | null | undefined;
  readonly state: string;
}) =>
  !NOT_STARTED.has(task.lane ?? "") &&
  !FINISHED.has(task.lane ?? "") &&
  !FINISHED_STATES.has(task.state) &&
  !MOVED.has(task.state) &&
  task.state !== "split";
