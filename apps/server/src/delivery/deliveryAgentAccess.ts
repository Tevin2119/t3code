import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthGrantScope,
  linkOriginIsFenced,
  mcpClientScopes,
} from "@t3tools/contracts";

import { callerLinkOrigin } from "../mcp/linkOrigin.ts";
import type { Caller } from "../mcp/threadAccess.ts";

/**
 * The one rule for board, task and engine actions, from a WebSocket session's scopes or an MCP
 * caller's (`mcpCallerScopes`): reading needs read, changing a board or task needs operate, and
 * stopping or restarting the engine, which uses the server's saved approval key, needs maintain:
 * the scope that saves that key.
 */
export type DeliveryAgentAction = "read" | "change" | "maintain";

const REQUIRED: Record<DeliveryAgentAction, AuthGrantScope> = {
  read: AuthOrchestrationReadScope,
  change: AuthOrchestrationOperateScope,
  maintain: AuthEnvironmentMaintainScope,
};

/** The scope the action needs and the caller lacks, or null when it may. */
export function missingDeliveryScope(
  granted: ReadonlyArray<string>,
  action: DeliveryAgentAction,
): AuthGrantScope | null {
  const required = REQUIRED[action];
  return granted.includes(required) ? null : required;
}

/**
 * What an MCP caller holds, in the scopes a WebSocket session would. An outside client and a
 * link hold what their approval grants, which is never maintain. A link paired below full
 * access only reads. This environment's own thread, outside any link, holds maintain only while
 * it runs in full access.
 */
export function mcpCallerScopes(caller: Pick<Caller, "scope" | "caller" | "limits">) {
  const client = caller.scope.client;
  if (client?.access === "read-only") return [AuthOrchestrationReadScope];
  const link = callerLinkOrigin(caller);
  if (link !== undefined)
    return linkOriginIsFenced(link)
      ? [AuthOrchestrationReadScope]
      : mcpClientScopes(link.access ?? "full-access");
  if (client !== undefined) return mcpClientScopes(client.access);
  const owner =
    caller.limits.runtimeMode === "full-access" && caller.limits.interactionMode === "default";
  return [
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
    ...(owner ? [AuthEnvironmentMaintainScope] : []),
  ];
}
