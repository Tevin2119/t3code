import type { DeliveryArchivedBoardThreads } from "@t3tools/contracts";

export type ArchivedBoardThread = DeliveryArchivedBoardThreads["threads"][number];

/**
 * The archived conversations the open board lists: its own, or every board's when every task is
 * shown. Newest archive first.
 */
export function archivedThreadsOfBoard(
  threads: ReadonlyArray<ArchivedBoardThread>,
  board: string,
): ReadonlyArray<ArchivedBoardThread> {
  return threads
    .filter((thread) => board === "all" || thread.board === board)
    .toSorted((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

/**
 * What the archive says under a thread whose task cannot take it back, or null for one that can
 * and is offered a restore. A restored thread of any other task holds nothing and is archived
 * again, so the restore is not offered for it.
 */
export function archivedThreadTaskNote(thread: ArchivedBoardThread): string | null {
  switch (thread.task) {
    case "open":
      return null;
    case "deleted":
      return "The task was deleted.";
    case "held":
      return "The task is held elsewhere.";
    case "unknown":
      return "The task could not be checked.";
  }
}
