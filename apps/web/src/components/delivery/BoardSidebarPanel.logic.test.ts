import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseCard, type TaskBrief } from "../../lib/delivery";
import { NO_FILTERS } from "../../lib/deliveryBoard";
import {
  panelCards,
  panelGroups,
  switcherGroups,
  type SwitcherRow,
} from "./BoardSidebarPanel.logic";

const card = (id: string, number: number, extra: Record<string, unknown> = {}) =>
  parseCard({ id, number, title: `Task ${number}`, lane: "ready", state: "ready", ...extra });
const brief = (id: string, number: number): TaskBrief => ({
  id,
  number,
  title: `Task ${number}`,
  state: "ready",
  lane: "ready",
});
const seatThread = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("seat") };
const seat = { seat: "builder", activity: "active", thread: seatThread };

/** A row as its id and depth, the open task marked: what the column draws, in order. */
const shape = (rows: ReadonlyArray<SwitcherRow>) =>
  rows.map((row) =>
    row.kind === "seat"
      ? `seat:${row.seat}@${row.depth}`
      : `${row.brief.id}@${row.depth}${row.current ? "*" : ""}`,
  );

describe("the board's column", () => {
  it("lists by the board's filters on the board, and by its own search alone while a task is open", () => {
    const cards = [card("a", 1, { tags: ["sync"] }), card("b", 2, { priority: "high" })];
    const filters = { ...NO_FILTERS, tags: ["sync"], lanes: ["queue"], priority: "low" as const };
    expect(panelCards(cards, filters, false)).toEqual([]);
    expect(panelCards(cards, filters, true)).toEqual(cards);
  });

  it("counts only work in play with the team, as the thread task panel lists it", () => {
    // The owner's board: 728 with the team, 723 of them closed.
    const closed = ["approved", "pr-open", "merged", "rejected", "closed"];
    const cards = Array.from({ length: 728 }, (_, at) =>
      card(`t${at}`, at, at < 723 ? { lane: "review", state: closed[at % 5] } : {}),
    );
    const groups = panelGroups(cards);
    expect(groups.open).toHaveLength(5);
    expect(groups.open.every((task) => task.state === "ready")).toBe(true);
    expect(groups.done).toHaveLength(20);
  });

  it("keeps a finished task that waits on the person in Waiting on you, not Done", () => {
    const waiting = { waitingOn: "person", waitsOnPerson: true };
    const groups = panelGroups([
      card("a", 1, { lane: "completed", ...waiting }),
      card("b", 2, { lane: "review", state: "pr-open", ...waiting }),
      card("c", 3, waiting),
      card("d", 4, { lane: "completed" }),
      card("e", 5, { lane: "review", state: "merged" }),
    ]);
    expect(groups.waiting.map((task) => task.id)).toEqual(["a", "b", "c"]);
    expect(groups.done.map((task) => task.id)).toEqual(["d", "e"]);
  });

  it("nests the open task's current children and seat conversations under its row, each task once", () => {
    const cards = [card("t1", 1), card("t2", 2), card("t3", 3)];
    const rows = switcherGroups(cards, {
      open: cards[0]!,
      parent: null,
      children: [brief("t2", 2)],
      seats: [seat],
    });
    expect(shape(rows.open)).toEqual(["t1@0*", "t2@1", "seat:builder@1", "t3@0"]);
  });

  it("puts the parent's row above the open task, nested under it, and the task's own family one deeper", () => {
    const cards = [card("t1", 1), card("t2", 2), card("t4", 4)];
    const rows = switcherGroups(cards, {
      open: cards[1]!,
      parent: brief("t1", 1),
      children: [brief("t4", 4)],
      seats: [seat],
    });
    expect(shape(rows.open)).toEqual(["t1@0", "t2@1*", "t4@2", "seat:builder@2"]);
  });

  it("shows what the list did not read from the open task's own read, at the head of its group", () => {
    // A part is off the board while its whole is on it, so the list may hold neither.
    const waiting = { waitingOn: "person", waitsOnPerson: true };
    const open = card("t2", 2, waiting);
    const rows = switcherGroups([card("t9", 9, waiting)], {
      open,
      parent: brief("t1", 1),
      children: [{ ...brief("t3", 3), lane: "human-review" }],
      seats: [],
    });
    expect(shape(rows.waiting)).toEqual(["t1@0", "t2@1*", "t3@2", "t9@0"]);
    // The open task waits by its own card; a task known only by its brief, by its lane.
    expect(rows.waiting.map((row) => row.kind === "task" && row.waits)).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });
});
