// The engine's finished board tasks, one list for the server and every client: finished work keeps
// the conversation it had, is given none anew, and takes no turns.

const FINISHED_LANES = new Set(["completed", "closed-not-done"]);
// The engine's closed states, which it never claims. An approved or open-PR task keeps its lane.
const FINISHED_STATES = new Set(["approved", "pr-open", "merged", "rejected", "closed"]);

/** What finished the task, its lane or else its state; `null` while it is not finished. */
export const boardTaskFinishedBy = (task: {
  readonly lane?: string | null | undefined;
  readonly state: string;
}): string | null =>
  FINISHED_LANES.has(task.lane ?? "")
    ? (task.lane ?? null)
    : FINISHED_STATES.has(task.state)
      ? task.state
      : null;
