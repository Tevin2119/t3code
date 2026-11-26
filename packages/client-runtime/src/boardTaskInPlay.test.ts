import { describe, expect, it } from "vite-plus/test";

import { boardTaskIsDone, boardTaskOwesPerson } from "./boardTaskInPlay.ts";

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

describe("boardTaskOwesPerson", () => {
  it("is owed for a wait on the person or an open question, even with no wait set", () => {
    expect(boardTaskOwesPerson({ waitingOn: "person", questions: 0 })).toBe(true);
    expect(boardTaskOwesPerson({ waitingOn: null, questions: 1 })).toBe(true);
    expect(boardTaskOwesPerson({ waitingOn: "team", questions: 0 })).toBe(false);
    expect(boardTaskOwesPerson({})).toBe(false);
  });
});
