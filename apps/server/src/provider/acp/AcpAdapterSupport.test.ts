import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  acpPermissionOutcome,
  autoApprovedAcpPermissionOptionId,
  mapAcpToAdapterError,
} from "./AcpAdapterSupport.ts";

describe("autoApprovedAcpPermissionOptionId", () => {
  const toolCall = { toolCallId: "t1" };
  it("prefers the standing allowance, then a single one, and never a rejection", () => {
    expect(
      autoApprovedAcpPermissionOptionId({
        sessionId: "s",
        toolCall,
        options: [
          { optionId: "no", name: "Deny", kind: "reject_once" },
          { optionId: "once", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Always", kind: "allow_always" },
        ],
      }),
    ).toBe("always");
    expect(
      autoApprovedAcpPermissionOptionId({
        sessionId: "s",
        toolCall,
        options: [
          { optionId: "no", name: "Deny", kind: "reject_once" },
          { optionId: "once", name: "Allow", kind: "allow_once" },
        ],
      }),
    ).toBe("once");
    expect(
      autoApprovedAcpPermissionOptionId({
        sessionId: "s",
        toolCall,
        options: [{ optionId: "no", name: "Deny", kind: "reject_once" }],
      }),
    ).toBeUndefined();
  });
});

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });

  it("surfaces the transport error detail so a setup timeout is readable", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("hermes"),
      "thread-1" as never,
      "session/start",
      new EffectAcpErrors.AcpTransportError({
        operation: "call-rpc",
        method: "session/new",
        detail: "session/new timed out waiting for the agent response.",
        cause: undefined,
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("session/new timed out waiting for the agent response.");
  });
});
