import { describe, expect, it } from "vite-plus/test";

import { parseCard } from "../../lib/delivery";
import { reviewedAsPart, wholeName } from "./partOf.logic";
import { actionHelp, actionLabel } from "./taskActions";

const part = (partOf: unknown) =>
  parseCard({ id: "p1", number: 13, title: "A part", lane: "in-work", partOf });

describe("a part's whole", () => {
  it("is named by what the engine knows of it, never #0 or an empty title", () => {
    const named = part({ id: "w", number: 12, title: "Rework the sync", here: true }).partOf!;
    expect(wholeName(named)).toBe("#12 Rework the sync");
    expect(wholeName({ ...named, title: null })).toBe("#12");
    expect(wholeName({ ...named, title: "  " })).toBe("#12");
    expect(wholeName({ ...named, number: null })).toBe("Rework the sync");
    const unknown = part({ id: "w", number: null, title: null, here: false }).partOf!;
    expect(unknown).toEqual({ id: "w", number: null, title: null, here: false });
    expect(wholeName(unknown)).toBeNull();
    // An older engine served no `here`: its part is not taken as reviewable as a part.
    expect(part({ id: "w", number: 12, title: "t" }).partOf?.here).toBe(false);
  });

  it("offers Mark as reviewed only while the whole is on this engine", () => {
    const here = part({ id: "w", number: 12, title: "Rework the sync", here: true });
    const away = part({ id: "w", number: 12, title: "Rework the sync", here: false });
    expect(reviewedAsPart(here)).toBe(true);
    expect(reviewedAsPart(away)).toBe(false);
    expect(reviewedAsPart(part(null))).toBe(false);
    expect(actionLabel("approve", here)).toBe("Mark part as reviewed");
    expect(actionLabel("reject", here)).toBe("Send part back");
    expect(actionLabel("approve", away)).toBe(actionLabel("approve", null));
    expect(actionHelp("approve", here)).toContain("the whole, #12 Rework the sync, which");
    expect(actionHelp("approve", away)).toBe(actionHelp("approve", null));
    const nameless = part({ id: "w", number: null, title: null, here: true });
    expect(actionHelp("approve", nameless)).toContain("It does not approve the whole, which");
    expect(actionHelp("reject", nameless)).toContain("The whole is put together");
    expect(actionHelp("approve", nameless)).not.toContain("#");
  });
});
