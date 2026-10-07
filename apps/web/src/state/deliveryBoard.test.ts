import { describe, expect, it } from "vite-plus/test";
import { createStore } from "zustand/vanilla";

import {
  boardPreferencesOf,
  createBoardState,
  migrateBoardState,
  type BoardState,
} from "./deliveryBoard";

describe("each environment's board", () => {
  it("keeps board, view, filters and layout choices separate when switching environments", () => {
    const store = createStore<BoardState>()(createBoardState);
    const update = store.getState().updateBoard;
    update("mac", (current) => ({
      boardSet: "mac-work",
      view: "mac-view",
      filters: { ...current.filters, q: "Mac task" },
      laneFolds: { ready: true },
      panelFolds: { done: true },
    }));
    store.getState().setDeliveryEnvironment("windows");
    expect(boardPreferencesOf(store.getState(), "windows")).toMatchObject({
      boardSet: "unsorted",
      view: "development",
      filters: { q: "" },
      laneFolds: {},
      panelFolds: {},
    });
    update("windows", () => ({ boardSet: "windows-work", view: "windows-view" }));
    store.getState().setDeliveryEnvironment("mac");
    expect(boardPreferencesOf(store.getState(), "mac")).toMatchObject({
      boardSet: "mac-work",
      view: "mac-view",
      filters: { q: "Mac task" },
      laneFolds: { ready: true },
      panelFolds: { done: true },
    });
    expect(boardPreferencesOf(store.getState(), "windows").boardSet).toBe("windows-work");
  });
  it("does not carry shared boards into another environment's local task list", () => {
    const store = createStore<BoardState>()(createBoardState);
    store.getState().updateBoard("mac", () => ({ shared: true, sharedBoardSet: "shared-pilot" }));
    expect(boardPreferencesOf(store.getState(), "windows")).toMatchObject({
      shared: false,
      sharedBoardSet: "",
    });
    expect(boardPreferencesOf(store.getState(), "mac")).toMatchObject({
      shared: true,
      sharedBoardSet: "shared-pilot",
    });
  });
  it("applies a late board creation to the environment that requested it", () => {
    const store = createStore<BoardState>()(createBoardState);
    store.getState().setDeliveryEnvironment("windows");
    store.getState().updateBoard("mac", () => ({ boardSet: "new-mac-board" }));
    expect(boardPreferencesOf(store.getState(), "windows").boardSet).toBe("unsorted");
    expect(boardPreferencesOf(store.getState(), "mac").boardSet).toBe("new-mac-board");
  });
});

describe("saved board choices from before environment scoping", () => {
  it("assigns the old board only to the environment it was chosen in", () => {
    const migrated = migrateBoardState({
      person: "Sam",
      deliveryEnvironment: "mac",
      boardSet: "pilot",
      view: "review",
      laneFolds: { done: true },
    });
    expect(boardPreferencesOf(migrated, "mac")).toMatchObject({
      boardSet: "pilot",
      view: "review",
      laneFolds: { done: true },
    });
    expect(boardPreferencesOf(migrated, "windows").boardSet).toBe("unsorted");
    expect(migrated.person).toBe("Sam");
  });
  it("does not attach a board to a machine when its old environment is unknown", () => {
    expect(
      migrateBoardState({ boardSet: "pilot", deliveryEnvironment: null }).preferencesByEnvironment,
    ).toEqual({});
  });
});
