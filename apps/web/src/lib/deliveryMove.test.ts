import { describe, expect, it } from "vite-plus/test";
import { parseRepositories, type DeliveryTarget } from "./delivery";
import {
  boardChoiceKind,
  deliveryRemoteOf,
  eligibleMoveBases,
  moveOutcomeLine,
  parseSuggestedBoard,
  relocateBody,
} from "./deliveryMove";

const target = (repository: string | null): DeliveryTarget => ({
  repository,
  base: "main",
  title: repository,
  path: null,
  ok: true,
  problem: null,
});

describe("choosing a board for a task", () => {
  it("only places a task on a board done in the same repository", () => {
    expect(
      boardChoiceKind("delivery-engine", {
        id: "a",
        title: "A",
        target: target("delivery-engine"),
      }),
    ).toBe("place");
  });

  it("asks before moving a task to a board done in another repository", () => {
    expect(
      boardChoiceKind("delivery-engine", { id: "t3", title: "T3", target: target("t3-code-fork") }),
    ).toBe("move");
  });

  it("asks when either repository is not known, rather than guess", () => {
    expect(boardChoiceKind("delivery-engine", { id: "b", title: "B", target: null })).toBe("move");
    expect(boardChoiceKind(null, { id: "t3", title: "T3", target: target("t3-code-fork") })).toBe(
      "move",
    );
  });

  it("takes a task off every board without asking", () => {
    expect(boardChoiceKind("delivery-engine", null)).toBe("place");
  });
});

describe("what a move says it does", () => {
  it("tells a submitted task goes back to triage and keeps what was built as history", () => {
    expect(moveOutcomeLine({ isDraft: false, to: "T3 Code fork", from: "Delivery engine" })).toBe(
      "It will be done in T3 Code fork and goes back to triage. Anything built for Delivery engine stays as history.",
    );
  });

  it("tells a draft stays a draft", () => {
    expect(moveOutcomeLine({ isDraft: true, to: "T3 Code fork", from: "Delivery engine" })).toBe(
      "It stays a draft, done in T3 Code fork.",
    );
  });

  it("still reads when a repository is not known", () => {
    expect(moveOutcomeLine({ isDraft: false, to: null, from: null })).toBe(
      "It will be done in the repository of that board and goes back to triage. Anything built before stays as history.",
    );
  });

  it("sends an empty base as the board's own base", () => {
    expect(relocateBody({ board: "t3", base: "  ", by: "T" })).toEqual({
      board: "t3",
      base: null,
      by: "T",
    });
    expect(relocateBody({ board: "t3", base: " fix/mobile-board-exit ", by: "T" })).toEqual({
      board: "t3",
      base: "fix/mobile-board-exit",
      by: "T",
    });
  });
});

describe("the board triage suggests", () => {
  it("is read when the engine names one, and ignored when it does not", () => {
    expect(
      parseSuggestedBoard({
        id: "t3",
        title: "T3 Code",
        repository: "t3-code-fork",
        repositoryTitle: "T3 Code fork",
        base: "fix/mobile-board-exit",
      }),
    ).toEqual({
      id: "t3",
      title: "T3 Code",
      repository: "t3-code-fork",
      repositoryTitle: "T3 Code fork",
      base: "fix/mobile-board-exit",
    });
    expect(parseSuggestedBoard({ id: "t3" })).toEqual({
      id: "t3",
      title: "t3",
      repository: "",
      repositoryTitle: "",
      base: null,
    });
    expect(parseSuggestedBoard(null)).toBeNull();
    expect(parseSuggestedBoard(undefined)).toBeNull();
    expect(parseSuggestedBoard({ title: "no id" })).toBeNull();
  });
});

describe("eligible move bases", () => {
  it.each([
    [{}, null],
    [{ delivery: { remote: "origin" } }, "origin"],
    [{ delivery: { remote: "/repo" } }, null],
    [{ delivery: { remote: "https://example.com/r" } }, null],
    [{ delivery: { remote: "origin", mode: "local" }, fetch: { remote: "resolved" } }, null],
    [{ delivery: { remote: "/repo" }, fetch: { remote: "delivery-123" } }, "delivery-123"],
    [{ fetch: { remote: "origin" } }, null],
    [{ delivery: { remote: "origin" }, fetch: { remote: "resolved" } }, "resolved"],
  ])("resolves delivery metadata %j", (metadata, expected) => {
    expect(deliveryRemoteOf(parseRepositories([{ id: "a", ...metadata }])[0])).toBe(expected);
  });
  it("keeps local slashes, scopes remotes, strips their prefix and deduplicates", () => {
    const refs = ["main", "feature/demo"].map((name) => ({
      name,
      current: false,
      isDefault: false,
      worktreePath: null,
    }));
    const remoteRefs = [
      { name: "delivery-123/feature/demo", isRemote: true },
      { name: "delivery-123/release", isRemote: true },
      { name: "other/no", isRemote: true, remoteName: "other" },
      { name: "delivery-123/feature/new", isRemote: true, remoteName: "delivery-123" },
    ].map((ref) => ({ ...ref, current: false, isDefault: false, worktreePath: null }));
    expect(eligibleMoveBases([...refs, ...remoteRefs], "delivery-123")).toEqual([
      "main",
      "feature/demo",
      "release",
      "feature/new",
    ]);
    expect(eligibleMoveBases([...refs, ...remoteRefs], null)).toEqual(["main", "feature/demo"]);
  });
});
