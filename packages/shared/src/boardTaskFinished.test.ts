import { describe, expect, it } from "vite-plus/test";

import { boardTaskFinishedBy } from "./boardTaskFinished.ts";

describe("boardTaskFinishedBy", () => {
  it("names the lane that finished a task before its state", () => {
    expect(boardTaskFinishedBy({ lane: "completed", state: "approved" })).toBe("completed");
    expect(boardTaskFinishedBy({ lane: "closed-not-done", state: "ready" })).toBe(
      "closed-not-done",
    );
  });

  it("treats every closed state as finished, approved and merged as much as closed", () => {
    for (const state of ["approved", "pr-open", "merged", "rejected", "closed"]) {
      expect(boardTaskFinishedBy({ lane: "implementation", state })).toBe(state);
    }
  });

  it("leaves a task in work, waiting or moved unfinished", () => {
    for (const state of ["ready", "in-work", "draft", "moved", "moving", "split"]) {
      expect(boardTaskFinishedBy({ lane: "implementation", state })).toBeNull();
    }
    expect(boardTaskFinishedBy({ state: "ready" })).toBeNull();
    expect(boardTaskFinishedBy({ lane: null, state: "ready" })).toBeNull();
  });
});
