import type { CheckoutUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { checkoutUpdateView } from "./CheckoutUpdate.logic";

const A = "a".repeat(40);
const B = "b".repeat(40);
const idle: CheckoutUpdateState = {
  running: { commit: A, subject: "Older work" },
  available: { commit: B, subject: "Newer work", behind: 3 },
  phase: "idle",
  message: null,
  checkedAt: null,
  lastOutcome: null,
};

describe("checkoutUpdateView", () => {
  it("offers a newer commit until it is dismissed", () => {
    expect(checkoutUpdateView(idle, { loadedCommit: A, dismissedCommit: null })).toMatchObject({
      kind: "available",
      description: "Newer work · 3 new commits",
    });
    expect(checkoutUpdateView(idle, { loadedCommit: A, dismissedCommit: B })).toBeNull();
  });

  it("asks for a reload once the server runs another commit than the page", () => {
    const updated = { ...idle, running: { commit: B, subject: "Newer work" }, available: null };
    expect(checkoutUpdateView(updated, { loadedCommit: A, dismissedCommit: null })?.kind).toBe(
      "reload",
    );
  });

  it("says an update that did not start was undone", () => {
    const undone: CheckoutUpdateState = {
      ...idle,
      phase: "failed",
      message: "bbbbbbb did not start. T3 went back to aaaaaaa.",
      lastOutcome: { from: A, to: B, status: "rolled-back", reason: "bbbbbbb did not start." },
    };
    expect(checkoutUpdateView(undone, { loadedCommit: A, dismissedCommit: null })).toMatchObject({
      kind: "failed",
      title: "T3 update undone",
    });
  });
});
