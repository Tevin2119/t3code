import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const isAcpTransportError = Schema.is(EffectAcpErrors.AcpTransportError);

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    // Transport errors keep the actionable reason (such as a setup timeout) in `detail`.
    detail: isAcpTransportError(error) && error.detail ? error.detail : error.message,
    cause: error,
  });
}

/**
 * The option a full-access thread answers a permission request with: the
 * agent's standing allowance when it offers one, otherwise a single allowance.
 * Undefined when the agent offered no way to allow, so the request still opens.
 */
export function autoApprovedAcpPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  for (const kind of ["allow_always", "allow_once"] as const) {
    const optionId = request.options.find((entry) => entry.kind === kind)?.optionId.trim();
    if (optionId) return optionId;
  }
  return undefined;
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}
