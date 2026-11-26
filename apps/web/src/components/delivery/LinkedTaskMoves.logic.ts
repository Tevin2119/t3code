import { DeliveryLinkedDestinationBoards, type LinkedHandoffOutcome } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeLocalBoards = Schema.decodeUnknownOption(DeliveryLinkedDestinationBoards);

export function localMoveBoards(body: unknown) {
  const boards = decodeLocalBoards(body);
  return boards._tag === "Some"
    ? boards.value.map((board) => ({
        ...board,
        kind: "own",
        linkedVisibility: board.linkedVisibility ?? "private",
      }))
    : null;
}

export function linkedMoveNotice(result: LinkedHandoffOutcome, machine: string): string {
  switch (result.outcome) {
    case "done":
      return "Task moved.";
    case "refused":
      return result.message;
    case "restored":
      return ["The task was restored on its source machine.", result.message]
        .filter(Boolean)
        .join(" ");
    case "needs-person": {
      const source = result.source === "linked" ? machine : "This machine";
      const destination = result.source === "linked" ? "This machine" : machine;
      const sourceStatus =
        result.sourceState === "frozen"
          ? `${source} holds the frozen source task.`
          : `${source} has not confirmed the source task's state.`;
      const destinationStatus = {
        accepted: `${destination} holds the paused copy.`,
        cancelled: `${destination} confirmed the task did not arrive.`,
        occupied: `${destination} already holds work with these task IDs.`,
        unknown: `${destination} has not confirmed receipt.`,
      }[result.destination];
      return `${result.message} ${sourceStatus} ${destinationStatus} You can finish the move later from Task moves on the Board.`;
    }
  }
}
