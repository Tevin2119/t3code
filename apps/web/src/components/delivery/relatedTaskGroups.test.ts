import { describe, expect, it } from "vite-plus/test";
import { relatedTaskGroups } from "./relatedTaskGroups";

describe("related task progress", () => {
  it("keeps current parts prominent instead of counting rejected earlier splits as unfinished work", () => {
    const previous = Array.from({ length: 14 }, (_, index) => ({
      id: `old-${index}`,
      number: 1050 + index,
      title: "Earlier split",
      state: "rejected",
      lane: null,
    }));
    const signOff = {
      id: "1199",
      number: 1199,
      title: "Closing a parent",
      state: "ready-for-pr",
      lane: "human-review",
    };
    const waiting = {
      id: "1200",
      number: 1200,
      title: "Reopening",
      state: "needs-decision",
      lane: "needs-decision",
    };
    const grouped = relatedTaskGroups([...previous, signOff, waiting]);
    expect(grouped.current).toEqual([signOff, waiting]);
    expect(grouped.historical).toEqual(previous);
    expect(grouped.completed).toEqual([]);
  });

  it("distinguishes delivered or accepted work from closed unfinished work without duplicating rows", () => {
    const accepted = {
      id: "accepted",
      number: 1,
      title: "Accepted artifact",
      state: "closed",
      lane: "completed",
    };
    const unfinished = {
      id: "unfinished",
      number: 2,
      title: "Closed early",
      state: "closed",
      lane: "closed-not-done",
    };
    const merged = { id: "merged", number: 3, title: "Merged", state: "merged", lane: "completed" };
    expect(relatedTaskGroups([accepted, unfinished, merged])).toEqual({
      current: [],
      completed: [accepted, merged],
      historical: [unfinished],
    });
  });
});
