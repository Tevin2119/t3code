import { describe, expect, it } from "vite-plus/test";
import { boardSelectionPatch, unifiedBoardChoices } from "./deliveryBoardSelection";

describe("one environment-scoped board selector", () => {
  const local = [{ id: "work", title: "Work", description: "Private", kind: "own", count: 3 }];
  const shared = [{ id: "work", title: "Work", repository: "owner/repo" }];

  it("keeps local and shared identities distinct even when ids or names match", () => {
    const choices = unifiedBoardChoices(local, shared, true);
    expect(choices.map((choice) => [choice.id, choice.scope])).toEqual([
      ["local:work", "local"],
      ["shared:", "shared"],
      ["shared:work", "shared"],
    ]);
    expect(choices[0]).toMatchObject({ count: 3, kind: "own" });
  });

  it("does not offer shared boards on an environment without a shared connection", () => {
    expect(unifiedBoardChoices(local, shared, false)).toHaveLength(1);
  });

  it("selects a source in one preference update without modifying its boards", () => {
    expect(boardSelectionPatch("local:work")).toEqual({ shared: false, boardSet: "work" });
    expect(boardSelectionPatch("shared:work")).toEqual({ shared: true, sharedBoardSet: "work" });
    expect(boardSelectionPatch("shared:")).toEqual({ shared: true, sharedBoardSet: "" });
    expect(boardSelectionPatch("local:shared:work")).toEqual({
      shared: false,
      boardSet: "shared:work",
    });
  });

  it.each(["", "local:", "work", "other:work"])(
    "refuses an unrecognized selection: %s",
    (value) => {
      expect(boardSelectionPatch(value)).toBeNull();
    },
  );
});
