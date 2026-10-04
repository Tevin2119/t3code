import { describe, expect, it } from "vite-plus/test";
import { glassRunState } from "./lookingGlass";

describe("Looking Glass evidence", () => {
  it("keeps stale, unrelated and exit-only evidence apart from verified assertions", () => {
    const receipt = {
      job: { id: "run-1", status: "checks-passed" },
      report: { runId: "run-1" },
      verification: { ok: true, assertionEvidence: true },
    };
    expect(glassRunState(receipt, "run-1")).toBe("tests passed");
    expect(glassRunState(receipt, "run-2")).toBe("not read");
    expect(glassRunState({ ...receipt, verification: { ok: false } }, "run-1")).toBe(
      "stale or unverified",
    );
    expect(glassRunState({ ...receipt, report: { runId: "old" } }, "run-1")).toBe(
      "stale or unverified",
    );
    expect(
      glassRunState({ ...receipt, verification: { ok: true, assertionEvidence: false } }, "run-1"),
    ).toBe("commands passed");
    expect(glassRunState(null, "run-1")).toBe("not read");
  });
});
