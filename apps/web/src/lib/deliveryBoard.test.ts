import { describe, expect, it } from "vite-plus/test";

import { parseCard } from "./delivery";
import {
  isConversationRef,
  taskFromConversation,
  activeFilters,
  boardAttentionCount,
  ageLabel,
  fileKindOf,
  filterLanes,
  formatBytes,
  groupCards,
  initialsOf,
  isSendKey,
  isTaskId,
  linesFromText,
  matchesCard,
  messageStateLabel,
  NO_FILTERS,
  pastedFileName,
  piecesOf,
  queryValue,
  tagsFromText,
  moveIntent,
} from "./deliveryBoard";

const card = (overrides: Record<string, unknown> = {}) =>
  parseCard({
    id: "task-0a1b2c3d4e",
    number: 1001,
    title: "Version flag for the command line",
    team: "development",
    lane: "implementation",
    state: "doing",
    owner: "Sam Field",
    priority: "high",
    tags: ["cli", "windows"],
    submitted: "2026-09-28T09:00:00Z",
    workers: [{ seat: "developer", harness: "claude", stage: "build" }],
    parts: [{ id: "task-2", number: 1007, title: "Parse the flag", lane: "ready" }],
    waitingOn: "team",
    ...overrides,
  });

describe("matchesCard", () => {
  it("finds a task by its number, with or without the sign", () => {
    expect(matchesCard(card(), { ...NO_FILTERS, q: "#1001" })).toBe(true);
    expect(matchesCard(card(), { ...NO_FILTERS, q: "1001" })).toBe(true);
    expect(matchesCard(card(), { ...NO_FILTERS, q: "100" })).toBe(true);
    expect(matchesCard(card(), { ...NO_FILTERS, q: "#2001" })).toBe(false);
    // A part is found by its own number, on the card of the task it is part of.
    expect(matchesCard(card(), { ...NO_FILTERS, q: "#1007" })).toBe(true);
  });

  it("looks for every word, in the title, the tags, the owner and who works on it", () => {
    expect(matchesCard(card(), { ...NO_FILTERS, q: "version windows" })).toBe(true);
    expect(matchesCard(card(), { ...NO_FILTERS, q: "VERSION sam" })).toBe(true);
    expect(matchesCard(card(), { ...NO_FILTERS, q: "claude" })).toBe(true);
    expect(matchesCard(card(), { ...NO_FILTERS, q: "version linux" })).toBe(false);
  });

  it("keeps to the filters set beside the search", () => {
    expect(matchesCard(card(), { ...NO_FILTERS, priority: "high" })).toBe(true);
    expect(matchesCard(card(), { ...NO_FILTERS, priority: "low" })).toBe(false);
    expect(matchesCard(card(), { ...NO_FILTERS, tag: "cli", team: "development" })).toBe(true);
    expect(matchesCard(card(), { ...NO_FILTERS, tag: "cli", team: "rnd" })).toBe(false);
    expect(matchesCard(card(), { ...NO_FILTERS, owner: "sam field" })).toBe(true);
    expect(matchesCard(card(), { ...NO_FILTERS, waiting: true })).toBe(false);
    expect(matchesCard(card({ waitingOn: "person" }), { ...NO_FILTERS, waiting: true })).toBe(true);
  });

  it("leaves lanes as they are when nothing is looked for", () => {
    const lanes = [{ lane: "ready", title: "Ready", cards: [card(), card({ number: 1002 })] }];
    expect(filterLanes(lanes, NO_FILTERS)).toBe(lanes);
    expect(filterLanes(lanes, { ...NO_FILTERS, q: "#1002" })[0]?.cards).toHaveLength(1);
  });
});

describe("groupCards", () => {
  const cards = [
    card({ id: "a", priority: "low", tags: ["docs"] }),
    card({ id: "b", priority: "urgent", tags: [] }),
    card({ id: "c", priority: "low", tags: ["cli"] }),
  ];

  it("groups by priority with the most pressing first, and keeps the order inside a group", () => {
    expect(
      groupCards(cards, "priority").map((group) => [group.title, group.cards.map((c) => c.id)]),
    ).toEqual([
      ["Urgent", ["b"]],
      ["Low", ["a", "c"]],
    ]);
  });

  it("groups by the first tag, and says so where there is none", () => {
    expect(groupCards(cards, "tag").map((group) => group.key)).toEqual(["cli", "docs", "untagged"]);
    expect(groupCards(cards, "none")).toEqual([{ key: "all", title: null, cards }]);
  });
});

describe("what a card is labelled with", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");

  it("says how long ago in the shortest form", () => {
    expect(ageLabel("2026-09-28T11:59:40Z", now)).toBe("now");
    expect(ageLabel("2026-09-28T11:15:00Z", now)).toBe("45m");
    expect(ageLabel("2026-09-28T03:00:00Z", now)).toBe("9h");
    expect(ageLabel("2026-09-20T12:00:00Z", now)).toBe("8d");
    expect(ageLabel("2026-08-28T12:00:00Z", now)).toBe("4w");
    expect(ageLabel("2026-01-28T12:00:00Z", now)).toBe("8mo");
    expect(ageLabel("not a time", now)).toBe("");
    expect(ageLabel(null, now)).toBe("");
  });

  it("makes initials of a name", () => {
    expect(initialsOf("Sam Field")).toBe("SF");
    expect(initialsOf("developer-2")).toBe("D2");
    expect(initialsOf("claude")).toBe("CL");
    expect(initialsOf("  ")).toBe("?");
  });

  it("says what became of a message", () => {
    expect(messageStateLabel("received", null)).toBe("Sent. Not read by the team yet");
    expect(messageStateLabel("seen", null)).toBe("Seen by the team");
    expect(messageStateLabel("applied", 3)).toBe("Taken into the task as revision 3");
    expect(messageStateLabel("said", null)).toBeNull();
  });
});

describe("files", () => {
  it("tells what kind of file it is from its type, and from its name where the type says little", () => {
    expect(fileKindOf("image/png", "a.png")).toBe("image");
    expect(fileKindOf("video/webm;codecs=vp9", "rec.webm")).toBe("video");
    expect(fileKindOf("audio/webm", "voice.webm")).toBe("audio");
    expect(fileKindOf("application/pdf", "spec.pdf")).toBe("pdf");
    expect(fileKindOf("application/octet-stream", "engine.log")).toBe("text");
    expect(fileKindOf("application/octet-stream", "archive.zip")).toBe("other");
  });

  it("cuts a file into pieces that cover it once", () => {
    expect(piecesOf(0)).toEqual([{ from: 0, to: 0, last: true }]);
    expect(piecesOf(10, 4)).toEqual([
      { from: 0, to: 4, last: false },
      { from: 4, to: 8, last: false },
      { from: 8, to: 10, last: true },
    ]);
    expect(piecesOf(8, 4).at(-1)).toEqual({ from: 4, to: 8, last: true });
  });

  it("names what was pasted by what it is and when, and keeps a real name", () => {
    const at = new Date(2026, 8, 28, 14, 5, 9);
    expect(pastedFileName({ name: "image.png", type: "image/png" }, at)).toBe(
      "screenshot-20260928-140509.png",
    );
    expect(pastedFileName({ name: "", type: "video/webm;codecs=vp9" }, at)).toBe(
      "screen-recording-20260928-140509.webm",
    );
    expect(pastedFileName({ name: "blob", type: "audio/webm" }, at)).toBe(
      "voice-recording-20260928-140509.webm",
    );
    expect(pastedFileName({ name: "gate-report.json", type: "application/json" }, at)).toBe(
      "gate-report.json",
    );
  });

  it("writes sizes as a person reads them", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
  });
});

describe("what is typed", () => {
  it("reads tags and lines", () => {
    expect(tagsFromText("#CLI, windows  cli,")).toEqual(["cli", "windows"]);
    expect(linesFromText("- first\n\n2. second\n  * third \nfourth")).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("writes a search into an address the engine path may carry", () => {
    const value = queryValue("#1001 it's (a) test*!");
    expect(value).toMatch(/^[A-Za-z0-9_\-=&%.:+~]*$/);
    expect(decodeURIComponent(value)).toBe("#1001 it's (a) test*!");
  });

  it("knows the id of a task", () => {
    expect(isTaskId("task-0a1b2c3d4e")).toBe(true);
    expect(isTaskId("thread-0a1b2c3d4e")).toBe(true);
    expect(isTaskId("task-../../x")).toBe(false);
    expect(isTaskId("#1001")).toBe(false);
    expect(isTaskId(1001)).toBe(false);
  });

  it("follows the person's own send key", () => {
    const key = (overrides: Partial<Parameters<typeof isSendKey>[0]> = {}) => ({
      key: "Enter",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      ...overrides,
    });
    expect(isSendKey(key(), "enter", "one line")).toBe(true);
    expect(isSendKey(key({ shiftKey: true }), "enter", "one line")).toBe(false);
    expect(isSendKey(key(), "mod-enter", "one line")).toBe(false);
    expect(isSendKey(key({ ctrlKey: true }), "mod-enter", "one line")).toBe(true);
    expect(isSendKey(key(), "mod-enter-multiline", "one line")).toBe(true);
    expect(isSendKey(key(), "mod-enter-multiline", "two\nlines")).toBe(false);
    expect(isSendKey(key({ metaKey: true }), "mod-enter-multiline", "two\nlines")).toBe(true);
    expect(isSendKey(key({ isComposing: true }), "enter", "x")).toBe(false);
    expect(isSendKey(key({ key: "a" }), "enter", "x")).toBe(false);
  });
});

describe("filtering by column", () => {
  const lanes = [
    { lane: "intake", title: "Intake", cards: [card({ lane: "intake" })] },
    {
      lane: "human-review",
      title: "Your sign-off",
      cards: [card({ lane: "human-review", number: 1002 })],
    },
  ] as unknown as Parameters<typeof filterLanes>[0];

  it("shows only the columns that were chosen, and a card only when its column is one of them", () => {
    const shown = filterLanes(lanes, { ...NO_FILTERS, lanes: ["human-review"] });
    expect(shown.map((lane) => lane.lane)).toEqual(["human-review"]);
    expect(matchesCard(card({ lane: "intake" }), { ...NO_FILTERS, lanes: ["human-review"] })).toBe(
      false,
    );
    expect(
      matchesCard(card({ lane: "human-review" }), { ...NO_FILTERS, lanes: ["human-review"] }),
    ).toBe(true);
  });

  it("says every filter that is on, by the names of the board, each with what turns it off", () => {
    const on = activeFilters(
      { ...NO_FILTERS, lanes: ["human-review", "intake"], waiting: true, priority: "high" },
      (lane) => (lane === "human-review" ? "Your sign-off" : "Intake"),
    );
    expect(on.map((item) => item.label)).toEqual([
      "Waiting on you",
      "Your sign-off",
      "Intake",
      "High priority",
    ]);
    expect(on.find((item) => item.label === "Your sign-off")?.clear).toEqual({ lanes: ["intake"] });
    expect(activeFilters(NO_FILTERS, (lane) => lane)).toEqual([]);
  });
});

describe("a task made from a conversation", () => {
  it("names the conversation, and keeps the first request, the later ones and the last answer", () => {
    const made = taskFromConversation({
      title: "Fix the export",
      ref: "env-1/thread-9",
      messages: [
        { role: "user", text: "The CSV export drops the last row." },
        { role: "reasoning", text: "thinking" },
        { role: "assistant", text: "It is an off-by-one in writer.ts." },
        { role: "user", text: "Also keep the header.\nMore detail." },
        { role: "assistant", text: "Fixed both; tests added." },
      ],
    });
    expect(made.title).toBe("Fix the export");
    expect(made.text).toContain('Made from the conversation "Fix the export" (env-1/thread-9).');
    expect(made.text).toContain("## What was asked\n\nThe CSV export drops the last row.");
    expect(made.text).toContain("## Asked since\n\n- Also keep the header.");
    expect(made.text).toContain("## Where the conversation ended\n\nFixed both; tests added.");
    expect(made.text).not.toContain("thinking");
  });

  it("recognises a conversation address", () => {
    expect(isConversationRef("env-1/thread-9")).toBe(true);
    expect(isConversationRef("../etc")).toBe(false);
    expect(isConversationRef("a/b/c")).toBe(false);
  });
});

describe("moveIntent", () => {
  const card = (
    lane: string,
    actions: ReadonlyArray<string> = [],
    more: { resumesIn?: string | null; recovering?: boolean } = {},
  ) => ({ lane, actions, ...more });

  it("takes a column a decision leads to by that decision, named as its button is", () => {
    expect(moveIntent(card("human-review", ["approve", "reject"]), "approved")).toEqual({
      kind: "action",
      action: "approve",
      label: "Approve",
    });
    expect(moveIntent(card("human-review", ["approve", "reject"]), "rework")).toMatchObject({
      action: "reject",
    });
    expect(moveIntent(card("approved", ["publish"]), "pull-request")).toMatchObject({
      action: "publish",
    });
    expect(moveIntent(card("chat", ["close"]), "completed")).toMatchObject({ action: "close" });
    expect(moveIntent(card("human-review", ["approve", "retriage"]), "triage")).toMatchObject({
      action: "retriage",
    });
  });

  it("starts a plan's delivery only from Ready, where the engine puts it", () => {
    expect(moveIntent(card("human-review", ["deliver", "close"]), "ready")).toMatchObject({
      action: "deliver",
    });
    expect(moveIntent(card("human-review", ["deliver", "close"]), "implementation").kind).toBe(
      "refused",
    );
  });

  it("lets a paused card go on only where it stood, and leaves a recovering one alone", () => {
    const paused = card("paused", ["resume", "approve"], { resumesIn: "human-review" });
    expect(moveIntent(paused, "human-review")).toEqual({ kind: "move", label: "Resume" });
    for (const lane of ["approved", "completed", "implementation", "triage"]) {
      const intent = moveIntent(paused, lane);
      expect(intent.kind).toBe("refused");
      expect(intent.kind === "refused" && intent.why).toMatch(
        /goes on where it stood, in Your sign-off/,
      );
    }
    const recovering = card("paused", ["retry"], { recovering: true, resumesIn: null });
    expect(moveIntent(recovering, "implementation").kind).toBe("refused");
  });

  it("names the engine's own moves, and refuses what no step leads to", () => {
    expect(moveIntent(card("triage"), "triage")).toEqual({ kind: "move", label: "Reorder" });
    expect(moveIntent(card("implementation", ["pause"]), "paused")).toEqual({
      kind: "move",
      label: "Pause",
    });
    expect(moveIntent(card("chat", ["close"]), "paused").kind).toBe("refused");
    expect(moveIntent(card("draft", ["submit"]), "triage")).toEqual({
      kind: "move",
      label: "Submit",
    });
    expect(moveIntent(card("intake", ["submit"]), "triage")).toEqual({
      kind: "move",
      label: "Submit",
    });
    expect(moveIntent(card("draft", ["submit"]), "completed").kind).toBe("refused");
    expect(moveIntent(card("implementation", ["pause"]), "approved").kind).toBe("refused");
    expect(moveIntent(card("completed"), "triage").kind).toBe("refused");
    expect(moveIntent(card("triage"), "validation").kind).toBe("refused");
  });
});

describe("moveIntent while a seat works", () => {
  it("refuses Triage with that reason, and still submits a card not yet submitted", () => {
    const working = moveIntent({ lane: "implementation", actions: ["pause", "stop"] }, "triage");
    expect(working.kind).toBe("refused");
    expect(working.kind === "refused" && working.why).toMatch(/A seat is working on it/);
    expect(moveIntent({ lane: "intake", actions: ["submit", "stop"] }, "triage")).toEqual({
      kind: "move",
      label: "Submit",
    });
  });
});

describe("moveIntent while every seat waits", () => {
  it("says a seat is about to start, not that it works", () => {
    const held = moveIntent(
      {
        lane: "implementation",
        actions: ["pause", "stop"],
        workers: [
          {
            seat: "developer",
            harness: null,
            role: null,
            stage: "build",
            specialist: null,
            since: null,
            waiting: "memory headroom",
          },
        ],
      },
      "triage",
    );
    expect(held.kind === "refused" && held.why).toMatch(/about to start on it, waiting for room/);
  });
});

describe("boardAttentionCount", () => {
  // The shape of a reading of /api/lanes?view=development&set=all, as the engine answers it.
  const lane = (id: string, cards: ReadonlyArray<Record<string, unknown>> = []) => ({
    lane: id,
    title: id,
    cards,
  });
  const task = (id: string, laneId: string, waitingOn: string | null = null) => ({
    id,
    number: 1,
    title: id,
    lane: laneId,
    waitingOn,
    set: "unsorted",
  });
  const reading = (lanes: ReadonlyArray<unknown>, overrides: Record<string, unknown> = {}) => ({
    view: "development",
    set: "all",
    lanes,
    closed: [],
    waiting: 0,
    ...overrides,
  });

  it("counts the tasks waiting on you", () => {
    expect(
      boardAttentionCount(
        reading([
          lane("needs-decision", [task("a", "needs-decision"), task("b", "needs-decision")]),
          lane("human-review"),
        ]),
      ),
    ).toBe(2);
  });

  it("counts the tasks waiting for your sign-off", () => {
    expect(
      boardAttentionCount(
        reading([lane("needs-decision"), lane("human-review", [task("a", "human-review")])]),
      ),
    ).toBe(1);
  });

  it("adds the two lanes together", () => {
    expect(
      boardAttentionCount(
        reading([
          lane("needs-decision", [
            task("a", "needs-decision", "person"),
            task("b", "needs-decision", "person"),
          ]),
          lane("human-review", [task("c", "human-review")]),
        ]),
      ),
    ).toBe(3);
  });

  it("is zero when both lanes are there and empty", () => {
    expect(boardAttentionCount(reading([lane("needs-decision"), lane("human-review")]))).toBe(0);
  });

  it("leaves out a draft and every other lane, even where a card waits on a person", () => {
    expect(
      boardAttentionCount(
        reading(
          [
            lane("draft", [task("a", "draft", "person"), task("b", "draft", "person")]),
            lane("needs-decision", [task("c", "needs-decision", "person")]),
            lane("ready", [task("d", "ready", "person")]),
            lane("implementation", [task("e", "implementation", "team")]),
            lane("human-review"),
            lane("completed", [task("f", "completed")]),
          ],
          { waiting: 4 },
        ),
      ),
    ).toBe(1);
  });

  it("does not take a reading it cannot trust for none", () => {
    const good = [lane("needs-decision", [task("a", "needs-decision")]), lane("human-review")];
    expect(boardAttentionCount(null)).toBeNull();
    expect(boardAttentionCount({ view: "development", set: "all" })).toBeNull();
    expect(boardAttentionCount(reading("oops" as never))).toBeNull();
    // A lane without its cards, or with cards that are not a list.
    expect(
      boardAttentionCount(reading([{ lane: "needs-decision" }, lane("human-review")])),
    ).toBeNull();
    expect(
      boardAttentionCount(
        reading([{ lane: "needs-decision", cards: "oops" }, lane("human-review")]),
      ),
    ).toBeNull();
    expect(boardAttentionCount(reading([...good, "oops"]))).toBeNull();
    // A card that is not one, alone or among good ones, in a lane that counts or one that does not.
    expect(
      boardAttentionCount(
        reading([{ lane: "needs-decision", cards: [null] }, lane("human-review")]),
      ),
    ).toBeNull();
    expect(
      boardAttentionCount(
        reading([
          lane("needs-decision"),
          {
            lane: "human-review",
            cards: [task("a", "human-review"), "oops", task("b", "human-review")],
          },
        ]),
      ),
    ).toBeNull();
    expect(boardAttentionCount(reading([...good, { lane: "draft", cards: [[]] }]))).toBeNull();
    // The engine lists every lane, so one that is missing was not read.
    expect(boardAttentionCount(reading([good[0]]))).toBeNull();
    expect(boardAttentionCount(reading([lane("human-review")]))).toBeNull();
    // Another board or view holds fewer tasks than there are.
    expect(boardAttentionCount(reading(good, { set: "unsorted" }))).toBeNull();
    expect(boardAttentionCount(reading(good, { set: undefined }))).toBeNull();
    expect(boardAttentionCount(reading(good, { view: "testing" }))).toBeNull();
  });

  it("does not add up a lane that counts when it is listed twice", () => {
    const waiting = lane("needs-decision", [
      task("a", "needs-decision"),
      task("b", "needs-decision"),
    ]);
    expect(boardAttentionCount(reading([waiting, waiting, lane("human-review")]))).toBeNull();
    expect(
      boardAttentionCount(
        reading([
          lane("needs-decision", [task("a", "needs-decision")]),
          lane("human-review"),
          lane("human-review"),
        ]),
      ),
    ).toBeNull();
    // Twice and empty both times is no more to be trusted.
    expect(
      boardAttentionCount(
        reading([lane("needs-decision"), lane("needs-decision"), lane("human-review")]),
      ),
    ).toBeNull();
    expect(
      boardAttentionCount(
        reading([lane("needs-decision"), lane("human-review"), lane("human-review")]),
      ),
    ).toBeNull();
    // Twice with another lane between the two.
    expect(boardAttentionCount(reading([waiting, lane("human-review"), waiting]))).toBeNull();
  });

  it("still counts when a lane that does not count is listed twice", () => {
    expect(
      boardAttentionCount(
        reading([
          lane("draft", [task("a", "draft")]),
          lane("needs-decision", [task("b", "needs-decision"), task("c", "needs-decision")]),
          lane("draft"),
          lane("human-review", [task("d", "human-review")]),
        ]),
      ),
    ).toBe(3);
  });
});
