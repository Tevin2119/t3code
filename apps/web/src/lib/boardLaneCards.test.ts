import { describe, expect, it } from "vite-plus/test";

import { queuePlaces, reworkOf, waitKindsOf, workSections, workStageOf } from "./boardLaneCards";
import { parseCard } from "./delivery";

const card = (extra: Record<string, unknown> = {}) =>
  parseCard({ id: "t", number: 1, title: "t", lane: "implementation", ...extra });

describe("the stage of a card in work", () => {
  it("reads run.stage, with the engine's other stage names in the section that does their work", () => {
    expect(workStageOf(card({ run: { stage: "checks" } }))).toBe("checks");
    expect(workStageOf(card({ run: { stage: "qa" } }))).toBe("qa");
    expect(workStageOf(card({ run: { stage: "admit" } }))).toBe("plan");
    expect(workStageOf(card({ run: { stage: "setup" } }))).toBe("build");
    expect(workStageOf(card({ run: { stage: "final-review" } }))).toBe("review");
  });

  it("tells a card being triaged, or reworked, by its lane: they have no stage of their own", () => {
    expect(workStageOf(card({ lane: "triage", run: null }))).toBe("triage");
    expect(workStageOf(card({ lane: "rework", run: { stage: "qa" } }))).toBe("build");
    expect(workStageOf(card({ lane: "planning", run: null }))).toBe("plan");
  });

  it("makes up no stage for a card neither its run nor its lane places", () => {
    expect(workStageOf(card({ lane: "new-lane", run: null }))).toBe("unknown");
    expect(workStageOf(card({ lane: "new-lane", run: { stage: "new-stage" } }))).toBe("unknown");
    // A lane that names the stage still does, whatever the run calls it.
    expect(workStageOf(card({ lane: "planning", run: { stage: "new-stage" } }))).toBe("plan");
    const sections = workSections([
      card({ id: "u", lane: "new-lane", run: null }),
      card({ id: "q", run: { stage: "qa" } }),
    ]);
    expect(sections.map((s) => [s.stage, s.cards.map((c) => c.id)])).toEqual([
      ["qa", ["q"]],
      ["unknown", ["u"]],
    ]);
  });

  it("makes a section only for a stage that holds a card, in stage order", () => {
    const sections = workSections([
      card({ id: "q", run: { stage: "qa" } }),
      card({ id: "p", run: { stage: "plan" } }),
      card({ id: "p2", run: { stage: "plan" } }),
    ]);
    expect(sections.map((s) => [s.stage, s.cards.length])).toEqual([
      ["plan", 2],
      ["qa", 1],
    ]);
  });

  it("counts a rework round on the card, only as far as the engine counts it", () => {
    expect(reworkOf(card({ reworkRounds: 2 }))).toEqual({ rounds: 2 });
    expect(reworkOf(card({ lane: "rework" }))).toEqual({ rounds: null });
    expect(reworkOf(card())).toBeNull();
  });
});

describe("the queue", () => {
  it("numbers submitted cards in the order given, and leaves an unsubmitted one out of line", () => {
    const places = queuePlaces([
      card({ id: "a", submitted: "2026-11-21T00:00:00Z" }),
      card({ id: "draft", submitted: null }),
      card({ id: "b", submitted: "2026-11-21T00:01:00Z" }),
    ]);
    expect([...places]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("takes the engine's position and slots when it sends them", () => {
    const sent = card({
      id: "a",
      queue: { position: 3, cap: 4, busy: 4, holders: [{ id: "x", number: 7, title: "Holder" }] },
    });
    expect(sent.queue).toMatchObject({ cap: 4, busy: 4, holders: [{ number: 7 }] });
    expect(queuePlaces([sent]).get("a")).toBe(3);
    expect(card({ queue: { position: "soon" } }).queue).toBeNull();
  });
});

describe("what a person owes a card", () => {
  const owed = (extra: Record<string, unknown>) =>
    waitKindsOf(card({ waitsOnPerson: true, waitingOn: "person", ...extra }));

  it("names a question, a plan to read and a sign-off from the card's own fields", () => {
    expect(owed({ questions: 2 })).toEqual(["question"]);
    expect(owed({ lane: "human-review", actions: ["deliver", "close"] })).toEqual(["plan"]);
    expect(owed({ lane: "human-review", actions: ["approve", "reject"] })).toEqual(["sign-off"]);
    expect(owed({ questions: 1, actions: ["approve", "reject"] })).toEqual([
      "question",
      "sign-off",
    ]);
  });

  it("does not ask for a sign-off that already stands", () => {
    expect(owed({ actions: ["approve"], approveStands: true })).toEqual(["other"]);
  });

  it("says nothing the engine did not say: not waiting, or a draft, has no kind", () => {
    expect(waitKindsOf(card({ questions: 3, actions: ["approve"] }))).toEqual([]);
    expect(owed({ lane: "draft", actions: ["submit"] })).toEqual([]);
    expect(owed({ lane: "paused", actions: ["resume"] })).toEqual(["resume"]);
  });
});
