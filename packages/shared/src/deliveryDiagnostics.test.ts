import { describe, expect, it } from "vite-plus/test";

import { deliveryFailureDiagnostic } from "./deliveryDiagnostics.ts";

const refusal = (fields: Record<string, unknown>) => ({ _tag: "DeliveryError", ...fields });
const delivery = new URL("http://engine.invalid/api/delivery?task=task-7");

describe("deliveryFailureDiagnostic", () => {
  it.each([
    ["disabled", refusal({ reason: "disabled" }), {}],
    ["unauthorized", refusal({ reason: "refused", status: 401 }), {}],
    ["unauthorized", refusal({ reason: "refused", status: 403 }), {}],
    ["unreachable", refusal({ reason: "unreachable" }), {}],
    ["unreachable", { _tag: "TimeoutError" }, {}],
    ["unsupported-server", refusal({ reason: "invalid" }), {}],
    ["unsupported-server", { _tag: "ParseError" }, {}],
    ["profile-mismatch", refusal({ reason: "mismatch" }), {}],
    ["response-too-large", refusal({ reason: "refused", status: 413 }), {}],
    ["invalid-request", refusal({ reason: "refused", status: 409 }), { endpoint: delivery }],
    [
      "task-not-found",
      refusal({ reason: "refused", status: 404 }),
      { endpoint: delivery, task: "task-7" },
    ],
  ] as const)("names %s", (code, failure, context) => {
    expect(deliveryFailureDiagnostic(failure, context)).toBe(code);
  });

  it("does not take a 404 about another task, or a 409 elsewhere, for a task or request problem", () => {
    const failure = refusal({ reason: "refused", status: 404 });
    expect(deliveryFailureDiagnostic(failure, { endpoint: delivery, task: "task-8" })).toBe(
      "unsupported-server",
    );
    const lanes = new URL("http://engine.invalid/api/lanes");
    expect(
      deliveryFailureDiagnostic(refusal({ reason: "refused", status: 409 }), { endpoint: lanes }),
    ).toBe("unsupported-server");
  });

  it.each([
    "configuration-changed",
    "missing-target",
    "missing-deployment",
    "unregistered-repository",
  ] as const)("reads %s from a launch the server blocked", (code) => {
    const failure = refusal({
      reason: "invalid",
      status: 409,
      detail: `Delivery launch blocked: ${code}. No work was submitted.`,
    });
    expect(deliveryFailureDiagnostic(failure, { endpoint: delivery })).toBe(code);
  });

  it("ignores a launch refusal naming no known diagnostic", () => {
    const failure = refusal({
      reason: "refused",
      status: 409,
      detail: "Delivery launch blocked: made-up. No work was submitted.",
    });
    expect(deliveryFailureDiagnostic(failure, { endpoint: delivery })).toBe("invalid-request");
  });
});
