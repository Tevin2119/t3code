import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type AuthMcpClientAccess,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { mcpCallerScopes, missingDeliveryScope } from "./deliveryAgentAccess.ts";

const base: McpInvocationScope = {
  environmentId: EnvironmentId.make("env-here"),
  requestNamespace: "session",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  thread: undefined,
  client: undefined,
};
const full = { runtimeMode: "full-access", interactionMode: "default" } as const;
const client = (access: AuthMcpClientAccess, linked = false) => ({
  scope: { ...base, client: { sessionId: "s", label: "Peer", access, linked } },
  caller: undefined,
  limits: full,
});
const may = (
  caller: Parameters<typeof mcpCallerScopes>[0],
  action: "read" | "change" | "maintain",
) => missingDeliveryScope(mcpCallerScopes(caller), action) === null;

it("decides board and engine actions from scopes, the same for every caller", () => {
  assert.isNull(missingDeliveryScope([AuthOrchestrationOperateScope], "change"));
  assert.equal(
    missingDeliveryScope([AuthOrchestrationOperateScope], "maintain"),
    AuthEnvironmentMaintainScope,
  );

  const ownThread = { scope: base, caller: undefined, limits: full };
  assert.deepEqual(
    (["read", "change", "maintain"] as const).map((action) => may(ownThread, action)),
    [true, true, true],
  );
  // The same thread below full access may change boards but not stop the engine.
  const supervised = { ...ownThread, limits: { ...full, runtimeMode: "auto" as const } };
  assert.deepEqual([may(supervised, "change"), may(supervised, "maintain")], [true, false]);

  // A link or an outside client never holds maintain, whatever access it was paired with.
  for (const caller of [client("full-access", true), client("full-access")])
    assert.deepEqual([may(caller, "change"), may(caller, "maintain")], [true, false]);
  // Below full access, a link only reads; a read-only client only reads.
  for (const caller of [client("auto", true), client("read-only")])
    assert.deepEqual([may(caller, "read"), may(caller, "change")], [true, false]);

  // A thread a link started is held to that link's pairing, not to its own modes.
  const linkedThread = {
    scope: base,
    caller: { linkOrigin: { sessionId: "s", label: "Peer", access: "auto" as const } },
    limits: full,
  };
  assert.isFalse(may(linkedThread as never, "change"));
});
