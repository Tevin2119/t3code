/**
 * Why a turn failed, from whatever ended it.
 *
 * An agent may answer a prompt with an error its protocol names, or with one
 * that does not fit what the protocol allows. The second reaches the adapter
 * as a defect and not as a failure, and a turn that ended that way has ended
 * all the same: it is recorded as failed, with the words the agent gave.
 *
 * @module provider/acp/TurnFailure
 */
import * as Cause from "effect/Cause";

const messageOf = (found: unknown): string | undefined => {
  if (typeof found === "string") return found;
  if (found instanceof Error) return found.message;
  if (typeof found === "object" && found !== null && "message" in found) {
    const message = (found as { readonly message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return undefined;
};

/** A turn that was interrupted was stopped, and did not fail. */
export const turnFailed = (cause: Cause.Cause<unknown>): boolean => !Cause.hasInterruptsOnly(cause);

export function turnFailureMessage(cause: Cause.Cause<unknown>, harness: string): string {
  const message = messageOf(Cause.squash(cause))?.trim();
  return message && message.length > 0
    ? message
    : `${harness} ended the turn with an error it did not name.`;
}
