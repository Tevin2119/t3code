import { describe, expect, it } from "vite-plus/test";

import { linkedMoveActor, localMoveBoards } from "./LinkedTaskMoves.logic";

describe("localMoveBoards", () => {
  it("reads the owner board list and defaults to private on older engines", () => {
    expect(
      localMoveBoards([
        { id: "work", title: "Work", description: "", linkedVisibility: "shared" },
        { id: "home", title: "Home", description: "" },
      ]),
    ).toMatchObject([
      { id: "work", linkedVisibility: "shared" },
      { id: "home", linkedVisibility: "private" },
    ]);
  });

  it("refuses choices whose visibility or path ID cannot be decoded", () => {
    expect(
      localMoveBoards([{ id: "work", title: "Work", description: "", linkedVisibility: true }]),
    ).toBeNull();
    expect(localMoveBoards([{ id: "work%2Fhome", title: "Work", description: "" }])).toBeNull();
  });
});

it.each([
  ["", "", null],
  ["", "  ", null],
  ["", "  Alex  ", "Alex"],
  ["  Taylor  ", "Alex", "Taylor"],
  ["a".repeat(60), "", "a".repeat(60)],
  ["a".repeat(61), "", null],
  ["a".repeat(61), "  Alex  ", "Alex"],
  ["", "a".repeat(61), null],
])("chooses the saved or entered actor for a keyed move (%j, %j)", (person, enteredName, by) => {
  expect(linkedMoveActor(person, enteredName)).toBe(by);
});
