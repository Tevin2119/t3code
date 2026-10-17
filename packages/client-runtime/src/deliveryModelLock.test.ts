import { describe, expect, it } from "vite-plus/test";
import { ThreadId, type DeliveryThreadBinding } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { confirmedDeliveryBinding, deliveryModelDisabledReason } from "./deliveryModelLock.ts";

const binding: DeliveryThreadBinding = {
  threadId: ThreadId.make("thread-1"),
  session: "session",
  team: "development",
  role: "implementer",
  seat: "developer",
  harness: "claude",
  driver: "claudeAgent",
  workspace: "/repo",
  configuration: "development@1#digest",
  requestedModel: null,
  memoryScope: "team",
  tools: [],
  project: "project",
  boundAt: "2026-10-13T00:00:00Z",
};

describe("delivery model lock", () => {
  it("matches the driver while explaining the engine harness alias", () => {
    expect(deliveryModelDisabledReason(binding, "claudeAgent")).toBeNull();
    expect(deliveryModelDisabledReason(binding, "claude")).toBe(
      "This thread is the development implementer on claude. Start a new thread to use another harness.",
    );
    expect(deliveryModelDisabledReason(null, "pi")).toBeNull();
  });
  it("accepts only a successful confirmed binding for the queried thread", () => {
    const state = { binding, pending: null };
    expect(confirmedDeliveryBinding(AsyncResult.success(state), "thread-1")).toBe(binding);
    expect(confirmedDeliveryBinding(AsyncResult.success(state), "thread-2")).toBeNull();
    expect(confirmedDeliveryBinding(AsyncResult.initial(true), "thread-1")).toBeNull();
    expect(
      confirmedDeliveryBinding(AsyncResult.failure(Cause.die("offline")), "thread-1"),
    ).toBeNull();
    expect(
      confirmedDeliveryBinding(
        AsyncResult.success({
          binding: null,
          pending: {
            threadId: binding.threadId,
            team: "development",
            role: "implementer",
            driver: "pi",
            cwd: "/repo",
            since: "today",
            why: null,
          },
        }),
        "thread-1",
      ),
    ).toBeNull();
  });
});
