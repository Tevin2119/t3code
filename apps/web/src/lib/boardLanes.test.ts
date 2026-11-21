import { describe, expect, it } from "vite-plus/test";

import { BOARD_LANE, BOARD_LANES, boardLaneOf, engineLanesOf, regroupLanes } from "./boardLanes";
import { parseCard, type DeliveryLane } from "./delivery";
import { boardMoveIntent, filterLanes, NO_FILTERS } from "./deliveryBoard";

/** The engine's lane ids today, in its own order (LANES in the engine's views.mjs). */
const ENGINE_LANES = [
  "draft",
  "chat",
  "intake",
  "triage",
  "needs-decision",
  "ready",
  "planning",
  "implementation",
  "validation",
  "child-work",
  "human-review",
  "paused",
  "rework",
  "approved",
  "pull-request",
  "closed-not-done",
  "completed",
];

const card = (id: string, lane: string, extra: Record<string, unknown> = {}) =>
  parseCard({ id, number: 1, title: id, lane, ...extra });
const lane = (id: string, cards: ReturnType<typeof card>[] = []): DeliveryLane => ({
  lane: id,
  title: `engine ${id}`,
  cards,
});

describe("the 11 board lanes", () => {
  it("puts every engine lane in one of the 11, and fills each of the 11", () => {
    const ids = BOARD_LANES.map((item) => item.id);
    expect(ids).toHaveLength(11);
    const homes = ENGINE_LANES.map(boardLaneOf);
    for (const home of homes) expect(ids).toContain(home);
    expect(new Set(homes)).toEqual(new Set(ids));
  });

  it("keeps an id it does not know, and the new ids map to themselves", () => {
    expect(boardLaneOf("somewhere-new")).toBe("somewhere-new");
    for (const id of Object.values(BOARD_LANE)) expect(boardLaneOf(id)).toBe(id);
  });

  it("merges lanes in the board's order and keeps a card of a lane it does not know", () => {
    const lanes = regroupLanes([
      lane("completed", [card("done", "completed")]),
      lane("intake", [card("a", "intake", { rank: 5 })]),
      lane("mystery", [card("odd", "mystery")]),
      lane("ready", [card("b", "ready", { rank: 2 }), card("c", "ready", { rank: 9 })]),
      lane("human-review", [card("review", "human-review", { rank: 3 })]),
      lane("needs-decision", [card("ask", "needs-decision", { rank: 1 })]),
    ]);
    expect(lanes.map((item) => item.lane)).toEqual([
      "queue",
      "needs-decision",
      "completed",
      "mystery",
    ]);
    expect(lanes[0]!.cards.map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(lanes[1]!.cards.map((item) => item.id)).toEqual(["ask", "review"]);
    expect(lanes[3]!.cards.map((item) => item.id)).toEqual(["odd"]);
  });

  it("puts a card a person put first at the head of the queue", () => {
    const lanes = regroupLanes([
      lane("ready", [
        card("a", "ready", { rank: 1 }),
        card("b", "ready", { rank: 7, first: true }),
      ]),
    ]);
    expect(lanes[0]!.cards.map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("shows only the lanes of a view that picked columns", () => {
    expect(regroupLanes([lane("triage"), lane("rework")]).map((item) => item.lane)).toEqual([
      "in-work",
    ]);
  });

  it("still filters by a lane chosen before the 11, and by the new ones", () => {
    const lanes = regroupLanes([lane("ready", [card("a", "ready")]), lane("paused")]);
    expect(filterLanes(lanes, { ...NO_FILTERS, lanes: ["ready"] }).map((l) => l.lane)).toEqual([
      "queue",
    ]);
    expect(filterLanes(lanes, { ...NO_FILTERS, lanes: ["queue"] })[0]!.cards).toHaveLength(1);
  });
});

describe("moving a card to a board lane", () => {
  it("asks the engine lane whose move is not refused, from the card's own actions", () => {
    expect(
      boardMoveIntent({ lane: "draft", actions: ["submit", "discard"] }, "queue"),
    ).toMatchObject({ intent: { kind: "move", label: "Submit" } });
    expect(
      boardMoveIntent({ lane: "human-review", actions: ["deliver", "close"] }, "queue"),
    ).toMatchObject({ lane: "ready", intent: { kind: "action", action: "deliver" } });
    expect(
      boardMoveIntent({ lane: "human-review", actions: ["approve", "reject"] }, "in-work"),
    ).toMatchObject({ lane: "rework", intent: { kind: "action", action: "reject" } });
    expect(
      boardMoveIntent({ lane: "human-review", actions: ["approve", "reject"] }, "needs-decision")
        .intent,
    ).toEqual({ kind: "move", label: "Reorder" });
  });

  it("lets a paused card go on where it stood, whichever stage of In work that was", () => {
    const paused = { lane: "paused", actions: ["resume"], resumesIn: "implementation" };
    expect(boardMoveIntent(paused, "in-work")).toMatchObject({
      lane: "implementation",
      intent: { kind: "move", label: "Resume" },
    });
  });

  it("refuses a lane the engine fills itself, with its reason", () => {
    expect(boardMoveIntent({ lane: "ready", actions: [] }, "child-work").intent.kind).toBe(
      "refused",
    );
    expect(engineLanesOf("queue")).toEqual(["ready", "intake"]);
  });
});
