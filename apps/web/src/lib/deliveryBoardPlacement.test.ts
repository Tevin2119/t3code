import { describe, expect, it } from "vite-plus/test";
import { boardPlacementChoices, matchingProjectBoard } from "./deliveryBoardPlacement";

const board = (id: string, folder = "/projects/ILM", ok = true) => ({
  id,
  title: id,
  target: { repository: null, base: null, title: "ILM", path: folder, ok, problem: null },
});

describe("project board suggestions", () => {
  it("suggests only a unique exact folder match", () => {
    expect(
      matchingProjectBoard([board("ilm"), board("other", "/projects/other")], "/projects/ILM/"),
    ).toBe("ilm");
    expect(matchingProjectBoard([board("ilm")], "/projects/ILM/subfolder")).toBeNull();
    expect(matchingProjectBoard([board("ilm"), board("another")], "/projects/ILM")).toBeNull();
    expect(
      matchingProjectBoard([board("ilm", "/projects/ILM", false)], "/projects/ILM"),
    ).toBeNull();
  });
  it("does not manufacture a board when the list or project is absent", () => {
    expect(matchingProjectBoard(null, "/projects/ILM")).toBeNull();
    expect(matchingProjectBoard([board("ilm")], null)).toBeNull();
    expect(boardPlacementChoices([{ team: "test" }, null])).toEqual([]);
  });
});
