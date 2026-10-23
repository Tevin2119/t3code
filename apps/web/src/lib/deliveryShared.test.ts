import { describe, expect, it } from "vite-plus/test";

import { parseAllocation, parseShared, sharedLanes } from "./deliveryShared";

describe("shared registry parsing", () => {
  it("rejects invalid roots and drops rows without usable identifiers or task summaries", () => {
    expect(parseShared(null)).toBeNull();
    expect(parseShared([])).toBeNull();
    const parsed = parseShared({
      enabled: true,
      boards: [null, { id: "" }, { id: "   " }, { id: "board-a" }],
      machines: [7, { id: "" }, { id: "   " }, { id: "host-a" }],
      tasks: [
        { id: "task-a", summary: { title: "Ready" } },
        { id: "task-b" },
        { id: "task-c", summary: [] },
        { id: "   ", summary: {} },
        { id: "../other", summary: {} },
        { id: "task?query", summary: {} },
        { id: "task/path", summary: {} },
      ],
      moves: [{ id: "" }, { id: "   " }, { id: "move-a", state: "received" }],
    });
    expect(parsed?.boards.map((board) => board.id)).toEqual(["board-a"]);
    expect(parsed?.machines.map((machine) => machine.id)).toEqual(["host-a"]);
    expect(parsed?.tasks.map((task) => task.id)).toEqual(["task-a"]);
    expect(parsed?.moves.map((move) => move.id)).toEqual(["move-a"]);
  });

  it("keeps policy decisions strict and normalizes malformed summaries", () => {
    const parsed = parseShared({
      enabled: "true",
      connected: true,
      boards: [
        { id: "a", revision: Infinity, policy: { automatic: "true", startOnArrival: true } },
      ],
      machines: [{ id: "a", seen: NaN }],
      tasks: [{ id: "task-a", summary: { title: 12, number: Infinity } }],
    });
    expect(parsed?.enabled).toBe(false);
    expect(parsed?.connected).toBe(true);
    expect(parsed?.boards[0]?.policy).toEqual({
      automatic: false,
      startOnArrival: true,
      machine: null,
      prefer: null,
    });
    expect(parsed?.boards[0]?.revision).toBe(0);
    expect(parsed?.machines[0]?.seen).toBe(0);
    expect(parsed?.tasks[0]).toMatchObject({ title: "", number: 0, lane: "intake" });
  });
});

describe("allocation parsing", () => {
  it("never offers a destination without a machine identifier and preserves refusal reasons", () => {
    expect(parseAllocation(undefined)).toEqual([]);
    expect(
      parseAllocation({
        machines: [
          null,
          [],
          { eligible: true },
          { machine: "   ", eligible: true },
          { machine: "host-a", eligible: true, reasons: ["Ready", 12, null] },
          { machine: "host-b", eligible: "true", reasons: ["Source still active"] },
        ],
      }),
    ).toEqual([
      { machine: "host-a", eligible: true, reasons: ["Ready"] },
      { machine: "host-b", eligible: false, reasons: ["Source still active"] },
    ]);
  });
});

describe("shared task grouping", () => {
  it("puts transfers in the moving lane without changing registry summaries", () => {
    const tasks = parseShared({
      tasks: [
        { id: "task-a", summary: { lane: "implementation" } },
        { id: "task-b", moving: "move-b", summary: { lane: "implementation" } },
        { id: "task-c", summary: { lane: "review" } },
        { id: "task-d", moving: "move-d", summary: { lane: "review" } },
        { id: "task-e", summary: { lane: "implementation" } },
      ],
    })!.tasks;
    const lanes = sharedLanes(tasks);
    expect(lanes.map(({ id, cards }) => ({ id, tasks: cards.map((card) => card.id) }))).toEqual([
      { id: "implementation", tasks: ["task-a", "task-e"] },
      { id: "moving", tasks: ["task-b", "task-d"] },
      { id: "review", tasks: ["task-c"] },
    ]);
    expect(tasks[1]?.lane).toBe("implementation");
    expect(sharedLanes([])).toEqual([]);
  });
});
