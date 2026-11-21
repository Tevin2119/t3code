import type { DeliveryDiscoveryDiagnostic } from "@t3tools/contracts";
import { useGT } from "gt-react";

/** The diagnostics a board screen names, each with its own words (BOARD-REVAMP-UI-SPEC 2.5). */
export const BOARD_DIAGNOSTICS = [
  "disabled",
  "configuration-changed",
  "unauthorized",
  "unreachable",
  "unsupported-server",
  "profile-mismatch",
  "response-too-large",
  "invalid-request",
  "task-not-found",
  "missing-target",
  "missing-deployment",
  "unregistered-repository",
] as const satisfies ReadonlyArray<DeliveryDiscoveryDiagnostic>;

function useDiagnosticCopy() {
  const gt = useGT();
  return (code: DeliveryDiscoveryDiagnostic): { title: string; detail: string } => {
    switch (code) {
      case "disabled":
        return {
          title: gt("Delivery is turned off"),
          detail: gt("Turn delivery on in this environment's server settings to read the board."),
        };
      case "configuration-changed":
        return {
          title: gt("Delivery settings changed during the read"),
          detail: gt("The answer was set aside because it came from the old settings. Refresh."),
        };
      case "unauthorized":
        return {
          title: gt("The engine refused this connection"),
          detail: gt(
            "This connection is not allowed to read the board. Check its delivery access.",
          ),
        };
      case "unreachable":
        return {
          title: gt("Delivery engine not reachable"),
          detail: gt("Nothing shown here is current until the engine answers again."),
        };
      case "unsupported-server":
        return {
          title: gt("This engine does not support this screen"),
          detail: gt(
            "It answered in a shape this version of T3 Code cannot read. Update the engine.",
          ),
        };
      case "profile-mismatch":
        return {
          title: gt("A different engine profile answered"),
          detail: gt("The engine at this address is not the profile these settings name."),
        };
      case "response-too-large":
        return {
          title: gt("The engine's answer was too large"),
          detail: gt("It was not read. Narrow the board or view and try again."),
        };
      case "invalid-request":
        return {
          title: gt("The engine refused the request as invalid"),
          detail: gt("Nothing was changed. Refresh the board before trying again."),
        };
      case "task-not-found":
        return {
          title: gt("Task not found"),
          detail: gt("The engine has no task by this id. It may have been removed or moved."),
        };
      case "missing-target":
        return {
          title: gt("This board has no target"),
          detail: gt(
            "It names no repository and base branch, so nothing can be published from it.",
          ),
        };
      case "missing-deployment":
        return {
          title: gt("No usable deployment project"),
          detail: gt("The board's deployment link is missing or no longer valid."),
        };
      case "unregistered-repository":
        return {
          title: gt("Repository not registered with the engine"),
          detail: gt(
            "Register the board's repository with the engine before linking a deployment.",
          ),
        };
      default:
        return { title: code, detail: "" };
    }
  };
}

/**
 * One discovery diagnostic in words. `problem` is the engine's own text, when it gave one,
 * and is shown as it is, under the diagnostic's own explanation.
 */
export function DeliveryDiagnosticNotice(props: {
  code: DeliveryDiscoveryDiagnostic;
  problem?: string | null;
  className?: string;
}) {
  const copy = useDiagnosticCopy()(props.code);
  return (
    <div
      role="status"
      className={props.className ?? "min-w-0 space-y-0.5 text-xs"}
      data-delivery-diagnostic={props.code}
    >
      <p className="font-medium text-warning-foreground">{copy.title}</p>
      {copy.detail ? <p className="text-muted-foreground">{copy.detail}</p> : null}
      {props.problem ? <p className="break-words text-muted-foreground">{props.problem}</p> : null}
    </div>
  );
}
