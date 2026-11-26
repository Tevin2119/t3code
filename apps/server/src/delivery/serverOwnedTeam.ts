import {
  DeliveryError,
  isServerOwnedThreadLineage,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/**
 * Lets a person change who joins a conversation only where the server does not own it, as the
 * team and lineup RPCs take it. The delivery service also refuses a board task's thread by its
 * id, so one whose shell cannot be found is refused too.
 */
export const refuseServerOwnedTeam = Effect.fn("DeliveryService.refuseServerOwnedTeam")(function* <
  E,
>(
  threadId: ThreadId,
  shellOf: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null, E>,
) {
  const shell = yield* shellOf(threadId).pipe(
    Effect.mapError(
      () => new DeliveryError({ reason: "storage", detail: "The conversation could not be read." }),
    ),
  );
  if (shell !== null && isServerOwnedThreadLineage(shell.lineage))
    return yield* new DeliveryError({
      reason: "refused",
      detail: "The board picks this task's team and models. Change them on the board.",
    });
});
