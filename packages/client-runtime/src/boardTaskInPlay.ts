// The engine's closed states: finished work it never claims again. A task that moved is worked
// on another board.
const CLOSED_STATES = new Set(["approved", "pr-open", "merged", "rejected", "closed", "moved"]);
const CLOSED_LANES = new Set(["completed", "closed-not-done"]);

/** A task the board has finished with: done, approved, merged, closed or moved away. */
export const boardTaskIsDone = (task: { readonly lane: string; readonly state: string }) =>
  CLOSED_LANES.has(task.lane) || CLOSED_STATES.has(task.state);

/** Owed to the person: it waits on them or has a question for them, finished or not. */
export const boardTaskOwesPerson = (task: {
  readonly waitingOn?: string | null | undefined;
  readonly questions?: number | undefined;
}) => task.waitingOn === "person" || (task.questions ?? 0) > 0;
