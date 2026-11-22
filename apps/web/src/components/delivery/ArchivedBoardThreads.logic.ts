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
