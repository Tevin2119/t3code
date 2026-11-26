import { describe, expect, it } from "vite-plus/test";

import { boardTaskIsDone } from "./boardTaskInPlay.ts";

describe("boardTaskIsDone", () => {
  it("is done for every closed state and lane, and in play otherwise", () => {
    for (const state of ["approved", "pr-open", "merged", "rejected", "closed", "moved"])
      expect(boardTaskIsDone({ lane: "review", state })).toBe(true);
    for (const lane of ["completed", "closed-not-done"])
      expect(boardTaskIsDone({ lane, state: "running" })).toBe(true);
    for (const state of ["running", "queued", "pending", "split"])
      expect(boardTaskIsDone({ lane: "review", state })).toBe(false);
  });
});
