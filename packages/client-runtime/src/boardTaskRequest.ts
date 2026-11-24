import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

export type BoardTaskRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "board_task_request" }
>;

export function boardTaskRequestLabel(
  { draft, resolution }: BoardTaskRequestItem,
  resolve: MFunctionType = mFallback,
): string {
  switch (resolution.status) {
    case "pending":
      return resolve(msg("Waiting in the original thread"));
    case "filed":
      return resolve(
        msg("Filed #{number} on {board}", {
          number: resolution.filing.task.number,
          board: resolution.filing.task.board ?? draft.board,
        }),
      );
    case "declined":
      return resolve(msg("Filing declined"));
    case "cancelled":
      return resolve(msg("Filing cancelled"));
    case "failed":
      return resolve(msg("Filing failed"));
  }
}

export function boardTaskAnswerError(failure: unknown, resolve: MFunctionType = mFallback): string {
  return typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "OrchestratorMcpFailure" &&
    "message" in failure &&
    typeof failure.message === "string"
    ? failure.message
    : resolve(msg("Could not send your answer. Try again."));
}
