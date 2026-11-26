// @effect-diagnostics nodeBuiltinImport:off - reads the source tree synchronously, once.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  conversationState,
  queueWait,
  seatChildrenWithAttestations,
  seatConversation,
  seatEnvironmentsNeedingLinks,
  seatLinksRefreshKey,
  seatThreadRows,
  taskConversation,
} from "./taskConversation";
import { parseBoardThread, parseCard, parseTask } from "./delivery";

const SRC = NodePath.resolve(import.meta.dirname, "..");
const sourceFiles = (directory: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });

const boardThread = {
  environmentId: "env-1",
  threadId: "thread-1",
  setBy: "env-1",
  setAt: "2026-11-22T10:00:00.000Z",
};
// The thread the task was filed from: another conversation, which must never stand in.
const source = { kind: "thread" as const, environmentId: "env-9", threadId: "filed-from" };
const ref = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") };

describe("which conversation a task has", () => {
  it("is the thread the engine links the task to, in work or sent back to the queue", () => {
    for (const lane of ["implementation", "queue", "completed"]) {
      expect(taskConversation({ boardThread, isDraft: false, lane, state: lane })).toEqual({
        kind: "thread",
        ref,
      });
    }
  });

  it("has none for a draft or a queued task with no link", () => {
    expect(
      taskConversation({ boardThread: null, isDraft: true, lane: "draft", state: "draft" }),
    ).toEqual({ kind: "none", why: "draft" });
    for (const lane of ["intake", "ready", "queue"]) {
      expect(taskConversation({ boardThread: null, isDraft: false, lane, state: lane })).toEqual({
        kind: "none",
        why: "queued",
      });
    }
  });

  it("is unlinked for a task in work with no link, and never the thread it was filed from", () => {
    const task = { boardThread: null, source, isDraft: false, lane: "planning", state: "planning" };
    expect(taskConversation(task)).toEqual({ kind: "none", why: "unlinked" });
  });

  it("opens none for a task the engine reports moved or moving, link or not", () => {
    for (const state of ["moved", "moving"]) {
      for (const link of [boardThread, null]) {
        expect(
          taskConversation({ boardThread: link, isDraft: false, lane: "implementation", state }),
        ).toEqual({ kind: "none", why: "moved" });
      }
    }
  });

  it("reads the link as the engine serves it, on the task and on its card", () => {
    const wire = { ...boardThread, threadId: "board-task:a%3Ab:c/with:colon" };
    expect(parseBoardThread(wire)).toEqual(wire);
    expect(parseTask({ id: "t", card: {}, boardThread: wire })?.boardThread).toEqual(wire);
    expect(parseCard({ id: "t", boardThread: wire }).boardThread).toEqual(wire);
    for (const none of [null, undefined, {}, { environmentId: "env-1" }, "thread-1"]) {
      expect(parseBoardThread(none)).toBeNull();
    }
    // `thread` is the task id and `source` the filing thread: neither is read as the link.
    const named = parseTask({
      id: "t",
      card: {},
      thread: "t",
      source: { kind: "thread", ref: "env-9/x" },
    });
    expect(named?.source?.threadId).toBe("x");
    expect(named?.boardThread).toBeNull();
  });

  it("is the only reader of the link", () => {
    // Taking the field off the wire is the parser's; a read is anything else that names it.
    const readers = sourceFiles(SRC).filter((file) =>
      NodeFS.readFileSync(file, "utf8")
        .split("\n")
        .some((line) => /\.boardThread\b/.test(line) && !line.includes("parseBoardThread(")),
    );
    expect(readers.map((file) => NodePath.relative(SRC, file))).toEqual([
      NodePath.join("lib", "taskConversation.ts"),
    ]);
  });
});

describe("what the centre shows", () => {
  const conversation = { kind: "thread" as const, ref };

  it("keeps the thread open, and says whether T3 is running", () => {
    expect(conversationState(conversation, true)).toEqual({ kind: "open", ref, offline: false });
    expect(conversationState(conversation, false)).toEqual({ kind: "open", ref, offline: true });
  });

  it("keeps a task with no conversation waiting, unlinked or moved, whether or not T3 is running", () => {
    expect(conversationState({ kind: "none", why: "queued" }, false)).toEqual({
      kind: "waiting",
      why: "queued",
    });
    expect(conversationState({ kind: "none", why: "unlinked" }, true)).toEqual({
      kind: "unlinked",
    });
    expect(conversationState({ kind: "none", why: "moved" }, true)).toEqual({ kind: "moved" });
  });
});

describe("a seat's conversation", () => {
  const id = ThreadId.make;
  const remote = EnvironmentId.make("env-remote");
  const children = [
    { childThreadId: id("child-a"), teamChat: { seat: "builder" } },
    { childThreadId: id("child-b"), teamChat: { seat: "qa" } },
    { childThreadId: id("child-c"), teamChat: { seat: "builder" } },
    { childThreadId: null, teamChat: { seat: "reviewer" } },
    { childThreadId: id("plain") },
    {
      childThreadId: null,
      remoteChild: { environmentId: remote, threadId: id("child-b"), label: "Desktop" },
      teamChat: { seat: "remote-qa" },
    },
  ];
  const reach = (own: { readonly connected: boolean } | undefined, linked: boolean) => ({
    ownConnection: () => own,
    isLinked: () => linked,
  });

  it("asks for the links of each machine a seat runs on that this client is not connected to", () => {
    const other = EnvironmentId.make("env-other");
    const seats = [
      ...children,
      {
        childThreadId: null,
        remoteChild: { environmentId: remote, threadId: id("again"), label: "Desktop" },
      },
      {
        childThreadId: null,
        remoteChild: { environmentId: other, threadId: id("child-o"), label: "Laptop" },
      },
    ];
    // A saved but offline connection still needs the link, so an offline machine is wanted too.
    const offline = (environmentId: EnvironmentId) =>
      environmentId === remote ? { connected: false } : undefined;
    expect(seatEnvironmentsNeedingLinks(seats, offline)).toEqual([remote, other]);
    expect(
      seatEnvironmentsNeedingLinks(seats, (environmentId) =>
        environmentId === remote ? { connected: true } : undefined,
      ),
    ).toEqual([other]);
    expect(seatEnvironmentsNeedingLinks(children.slice(0, 5), offline)).toEqual([]);
  });

  it("keeps a machine whose id has a comma whole, and asks again only when the machines change", () => {
    const comma = EnvironmentId.make("env-a,env-b");
    const [a, b] = [EnvironmentId.make("env-a"), EnvironmentId.make("env-b")];
    const seat = (environmentId: EnvironmentId) => ({
      childThreadId: null,
      remoteChild: { environmentId, threadId: id(`on-${environmentId}`), label: "Desktop" },
    });
    expect(seatEnvironmentsNeedingLinks([seat(comma)], () => undefined)).toEqual([comma]);
    expect(seatLinksRefreshKey(ref.environmentId, [comma])).not.toBe(
      seatLinksRefreshKey(ref.environmentId, [a, b]),
    );
    expect(seatLinksRefreshKey(ref.environmentId, [b, a])).toBe(
      seatLinksRefreshKey(ref.environmentId, [a, b]),
    );
    expect(seatLinksRefreshKey(ref.environmentId, [])).toBe("");
    expect(seatLinksRefreshKey(null, [a])).toBe("");
  });

  it("is the seat's newest delegated child in the same environment", () => {
    expect(seatConversation(ref, children, "builder")?.threadId).toBe("child-c");
    expect(seatConversation(ref, children, "qa")).toEqual({
      environmentId: ref.environmentId,
      threadId: "child-b",
    });
  });

  it("is nothing for a seat that was handed no work, or when the task has no conversation", () => {
    expect(seatConversation(ref, children, "reviewer")).toBeNull();
    expect(seatConversation(ref, children, "nobody")).toBeNull();
    expect(seatConversation(null, children, "qa")).toBeNull();
  });

  it("is the engine's thread for the seat in the task's environment, after T3's own child", () => {
    expect(seatConversation(ref, children, "reviewer", undefined, "engine-thread")).toEqual({
      environmentId: ref.environmentId,
      threadId: "engine-thread",
    });
    expect(seatConversation(ref, children, "builder", undefined, "engine-thread")?.threadId).toBe(
      "child-c",
    );
    expect(seatConversation(null, children, "reviewer", undefined, "engine-thread")).toBeNull();
  });

  it("opens a seat that runs in a linked environment there, or read-only through the link", () => {
    const there = { environmentId: remote, threadId: "child-b" };
    const throughLink = {
      ...there,
      linked: { viaEnvironmentId: ref.environmentId, label: "Desktop" },
    };
    expect(seatConversation(ref, children, "remote-qa", reach({ connected: true }, true))).toEqual(
      there,
    );
    expect(seatConversation(ref, children, "remote-qa", reach(undefined, true))).toEqual(
      throughLink,
    );
    // Saved but offline, with the link gone: it opens in place, where the client can reconnect.
    expect(
      seatConversation(ref, children, "remote-qa", reach({ connected: false }, false)),
    ).toEqual(there);
    // Neither connected nor linked: the read-only view says what to link again.
    expect(seatConversation(ref, children, "remote-qa", reach(undefined, false))).toEqual(
      throughLink,
    );

    const withAttestation = seatChildrenWithAttestations(ref, children, [
      { seat: "qa", seatThread: { environmentId: remote, threadId: "attested-qa" } },
    ]);
    const attested = { environmentId: remote, threadId: id("attested-qa") };
    expect(seatConversation(ref, withAttestation, "qa", reach({ connected: true }, true))).toEqual(
      attested,
    );
    expect(seatConversation(ref, withAttestation, "qa", reach(undefined, true))).toEqual({
      ...attested,
      linked: { viaEnvironmentId: ref.environmentId, label: remote },
    });
  });
});

describe("the seats' conversations as lineage rows", () => {
  const id = ThreadId.make;
  const remote = EnvironmentId.make("env-remote");
  const seats = [
    { seat: "builder", activity: "active" },
    { seat: "qa", activity: "waiting" },
    { seat: "reviewer", activity: "waiting" },
    { seat: "remote-qa", activity: "active" },
  ];
  // What the task thread's lineage lists itself: the subagents T3 spawned, here or remote.
  const listed = [
    { childThreadId: id("child-b"), teamChat: { seat: "builder" } },
    {
      childThreadId: null,
      remoteChild: { environmentId: remote, threadId: id("remote-child"), label: "Desktop" },
      teamChat: { seat: "remote-qa" },
    },
  ];
  const engineQa = { environmentId: ref.environmentId, threadId: id("engine-qa") };
  const linkedReviewer = {
    environmentId: remote,
    threadId: id("attested-reviewer"),
    linked: { viaEnvironmentId: ref.environmentId, label: "Desktop" },
  };
  const thread = (seat: string) =>
    ({
      builder: { environmentId: ref.environmentId, threadId: id("child-b") },
      qa: engineQa,
      reviewer: linkedReviewer,
      "remote-qa": { environmentId: remote, threadId: id("remote-child") },
    })[seat] ?? null;

  it("adds only the seats the thread does not already list as its own subagents", () => {
    expect(seatThreadRows(ref, listed, seats, thread)).toEqual([
      { seat: "qa", activity: "waiting", target: engineQa },
      { seat: "reviewer", activity: "waiting", target: linkedReviewer },
    ]);
  });

  it("keeps a seat on another machine reachable, through the link it opens by", () => {
    const [, reviewer] = seatThreadRows(ref, listed, seats, thread);
    expect(reviewer?.target.linked).toEqual({
      viaEnvironmentId: ref.environmentId,
      label: "Desktop",
    });
  });

  it("adds nothing for a seat with no conversation, or a task with none of its own", () => {
    expect(seatThreadRows(ref, [], [{ seat: "idle", activity: "waiting" }], () => null)).toEqual(
      [],
    );
    expect(seatThreadRows(null, [], seats, thread)).toEqual([]);
  });
});

describe("why a task waits", () => {
  it("reports only the engine's place, and says when none was sent", () => {
    const queue = { position: 3, cap: 4, busy: 4, holders: [] };
    expect(queueWait({ queue, submitted: "2026-11-21", blocker: null })).toEqual({
      place: 3,
      submitted: true,
      blocker: null,
    });
    expect(queueWait({ queue: null, submitted: "2026-11-21", blocker: "x" })).toEqual({
      place: null,
      submitted: true,
      blocker: "x",
    });
    expect(queueWait({ queue: null, submitted: null, blocker: null }).submitted).toBe(false);
  });
});
