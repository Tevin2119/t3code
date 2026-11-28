import { boardTaskFinishedBy } from "@t3tools/shared/boardTaskFinished";

/** A task the board has finished with: done, approved, merged, closed or moved away. */
export const boardTaskIsDone = (task: { readonly lane: string; readonly state: string }) =>
  // A task that moved is worked on another board, so this board is done with it too.
  boardTaskFinishedBy(task) !== null || task.state === "moved";

/** Owed to the person: it waits on them or has a question for them, finished or not. */
export const boardTaskOwesPerson = (task: {
  readonly waitingOn?: string | null | undefined;
  readonly questions?: number | undefined;
}) => task.waitingOn === "person" || (task.questions ?? 0) > 0;
