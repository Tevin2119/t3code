import {
  DeliveryError,
  type DeliverySetThreadLineupInput,
  isServerOwnedThreadLineage,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as DeliveryService from "./DeliveryService.ts";

/**
 * A person's change to who joins a conversation, as the lineup RPC takes it. A thread the server
 * owns, such as a board task's, keeps the team its owner picks, whatever a client shows.
 */
export const setPersonLineup = Effect.fn("DeliveryService.setPersonLineup")(function* <E>(
  input: DeliverySetThreadLineupInput,
  services: {
    readonly shellOf: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null, E>;
    readonly delivery: Pick<DeliveryService.DeliveryService["Service"], "setThreadLineup">;
  },
) {
  const shell = yield* services
    .shellOf(input.threadId)
    .pipe(
      Effect.mapError(
        () =>
          new DeliveryError({ reason: "storage", detail: "The conversation could not be read." }),
      ),
    );
  if (shell !== null && isServerOwnedThreadLineage(shell.lineage))
    return yield* new DeliveryError({
      reason: "refused",
      detail: "The board picks this task's team and models. Change them on the board.",
    });
  return yield* services.delivery.setThreadLineup(input);
});
