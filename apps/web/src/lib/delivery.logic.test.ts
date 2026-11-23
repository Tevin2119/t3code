import { describe, expect, it } from "vite-plus/test";

import { parseTask } from "./delivery";

describe("task seat results", () => {
  it("keeps hand-off, receipt, and model facts from the engine", () => {
    const task = parseTask({
      id: "task-a0b1c2",
      acceptance: ["First check", "Second check", "Third check"],
      card: { qaReceipts: { count: 2, pass: 1, fail: 1, blocked: 0 } },
      council: {
        seats: [
          {
            seat: "qa",
            harness: "claude",
            threadId: "seat-thread",
            seatThread: { environmentId: "remote", threadId: "seat-thread" },
            currentModel: { model: "gpt-6.2-sol", harness: "codex", source: "attested" },
          },
        ],
      },
      handoffs: [
        { stage: "review", seat: "reviewer", state: "fallen-back", reason: "seat-failed" },
        { stage: "review", seat: "reviewer", state: "handed" },
        { stage: "build", seat: "builder", state: "delivered" },
        { stage: "qa", seat: "qa", state: "unexpected" },
      ],
      qaReceipts: [
        {
          seat: "qa",
          acceptance: { index: 0, hash: "abc" },
          verdict: "pass",
          modelSource: "attested",
          model: "gpt-6.2-sol",
          independenceChecked: true,
        },
        {
          seat: "qa",
          acceptance: { index: 1 },
          verdict: "fail",
          modelSource: "picked",
          independenceChecked: false,
          evidence: ["report.log", "https://example.com/evidence", {}],
        },
        { seat: "qa", acceptance: { index: -1 }, verdict: "fail" },
        { seat: "qa", acceptance: {}, verdict: "blocked" },
      ],
    });

    expect(task?.council?.seats[0]).toMatchObject({
      threadId: "seat-thread",
      seatThread: { environmentId: "remote", threadId: "seat-thread" },
      attestedModel: { harness: "codex", model: "gpt-6.2-sol" },
    });
    expect(task?.handoffs).toEqual([
      { stage: "review", seat: "reviewer", state: "fallen-back", reason: "seat-failed" },
      { stage: "build", seat: "builder", state: "delivered", reason: null },
    ]);
    expect(task?.qaReceipts).toEqual([
      {
        seat: "qa",
        acceptance: { index: 0, hash: "abc" },
        verdict: "pass",
        model: "gpt-6.2-sol",
        modelSource: "attested",
        independenceChecked: true,
        evidence: [],
      },
      {
        seat: "qa",
        acceptance: { index: 1, hash: null },
        verdict: "fail",
        model: null,
        modelSource: "picked",
        independenceChecked: false,
        evidence: ["report.log", "https://example.com/evidence"],
      },
    ]);
    expect(task?.card.qaReceipts).toEqual({ count: 2, pass: 1, fail: 1, blocked: 0 });
  });

  it("distinguishes an older engine from a checklist with no receipts yet", () => {
    const task = { id: "task-a0b1c2", card: {}, acceptance: ["First check"] };
    expect(parseTask(task)).toMatchObject({
      acceptance: ["First check"],
      handoffs: [],
      qaReceipts: null,
      card: { qaReceipts: null },
    });
    expect(parseTask({ ...task, qaReceipts: [] })?.qaReceipts).toEqual([]);
  });
});
