import { msg } from "gt-react";

import { m } from "../../i18n/messages";
import { DeliveryLinkedDestinationBoards, type LinkedHandoffOutcome } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeLocalBoards = Schema.decodeUnknownOption(DeliveryLinkedDestinationBoards);

export const LINKED_MOVE_NAME_LIMIT = 60;

export function linkedMoveSavedName(person: string) {
  const name = person.trim();
  return name.length > 0 && name.length <= LINKED_MOVE_NAME_LIMIT ? name : null;
}

export function linkedMoveActor(person: string, enteredName: string) {
  return linkedMoveSavedName(person) ?? linkedMoveSavedName(enteredName);
}

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
      return m(msg("Task moved."));
    case "refused":
      return result.message;
    case "restored":
      return [m(msg("The task was restored on its source machine.")), result.message]
        .filter(Boolean)
        .join(" ");
    case "needs-person": {
      const source = result.source === "linked" ? machine : m(msg("This machine"));
      const destination = result.source === "linked" ? m(msg("This machine")) : machine;
      const sourceStatus =
        result.sourceState === "frozen"
          ? m(msg("{source} holds the frozen source task."), { source })
          : m(msg("{source} has not confirmed the source task's state."), { source });
      const destinationStatus = {
        accepted: m(msg("{destination} holds the paused copy."), { destination }),
        cancelled: m(msg("{destination} confirmed the task did not arrive."), { destination }),
        occupied: m(msg("{destination} already holds work with these task IDs."), { destination }),
        unknown: m(msg("{destination} has not confirmed receipt."), { destination }),
      }[result.destination];
      return [
        result.message,
        sourceStatus,
        destinationStatus,
        m(msg("You can finish the move later from Task moves on the Board.")),
      ].join(" ");
    }
  }
}
