import {
  DeliveryDiscoveryDiagnostic,
  type DeliveryDiscoveryDiagnostic as Diagnostic,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isDiagnostic = Schema.is(DeliveryDiscoveryDiagnostic);

/** The parts of a failed delivery call that say which diagnostic it is. */
export interface DeliveryFailure {
  readonly _tag?: unknown;
  readonly reason?: unknown;
  readonly status?: unknown;
  readonly detail?: unknown;
}

/** The engine path that failed and the task it was asked about, when known. */
export interface DeliveryFailureContext {
  readonly endpoint?: URL | undefined;
  readonly task?: string | undefined;
}

/**
 * The discovery diagnostic for one failed delivery call. The server's discovery and the web
 * board read the same failure through this, so a refusal is named the same way in both.
 */
export function deliveryFailureDiagnostic(
  failure: DeliveryFailure | null | undefined,
  context: DeliveryFailureContext = {},
): Diagnostic {
  if (!failure) return "unsupported-server";
  if (failure._tag === "TimeoutError") return "unreachable";
  if (failure._tag !== "DeliveryError") return "unsupported-server";
  // A launch the server refused names its own diagnostic: "Delivery launch blocked: <code>."
  const named =
    typeof failure.detail === "string"
      ? /^Delivery launch blocked: ([a-z-]+)\./.exec(failure.detail)?.[1]
      : undefined;
  if (named && isDiagnostic(named)) return named;
  const { endpoint, task } = context;
  if (failure.status === 401 || failure.status === 403) return "unauthorized";
  if (failure.status === 409 && endpoint?.pathname === "/api/delivery") return "invalid-request";
  if (
    failure.status === 404 &&
    task &&
    endpoint?.pathname === "/api/delivery" &&
    endpoint.searchParams.get("task") === task
  )
    return "task-not-found";
  if (failure.status === 413) return "response-too-large";
  if (failure.reason === "disabled") return "disabled";
  if (failure.reason === "mismatch") return "profile-mismatch";
  if (failure.reason === "unreachable") return "unreachable";
  return "unsupported-server";
}
