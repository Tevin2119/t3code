// @effect-diagnostics nodeBuiltinImport:off - reads the source tree synchronously, once.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  conversationState,
  queueWait,
  openSeatThread,
  seatConversation,
  seatOfThread,
  steadySeatThread,
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
  });

  it("names the seat a child thread was given, telling two environments' threads apart", () => {
    expect(seatOfThread(ref, children, { ...ref, threadId: id("child-b") })).toBe("qa");
    expect(seatOfThread(ref, children, { environmentId: remote, threadId: id("child-b") })).toBe(
      "remote-qa",
    );
    expect(
      seatOfThread(ref, children, { environmentId: remote, threadId: id("child-a") }),
    ).toBeNull();
    expect(seatOfThread(ref, children, { ...ref, threadId: id("plain") })).toBeNull();
  });

  it("follows the connection of a seat thread that is already open", () => {
    const open = { environmentId: remote, threadId: id("child-b") };
    expect(openSeatThread(ref, children, open, reach(undefined, true))?.linked).toEqual({
      viaEnvironmentId: ref.environmentId,
      label: "Desktop",
    });
    expect(openSeatThread(ref, children, open, reach({ connected: true }, true))).toEqual(open);
    // A thread that is no seat's, opened from a lineage link, stays as it was asked for.
    const other = { ...ref, threadId: id("elsewhere") };
    expect(openSeatThread(ref, children, other, reach(undefined, false))).toBe(other);
  });
});

describe("an open seat's view, held steady", () => {
  const remote = EnvironmentId.make("env-remote");
  const direct = { environmentId: remote, threadId: ThreadId.make("child-b") };
  const linked = { ...direct, linked: { viaEnvironmentId: ref.environmentId, label: "Desktop" } };
  const loading = { certain: false, connected: false };
  const loaded = { certain: true, connected: false };
  const online = { certain: true, connected: true };

  it("waits to place a newly opened seat until the links have loaded", () => {
    // Saved but offline reads as direct, and unsaved as linked, before the links say which.
    expect(steadySeatThread(null, direct, loading)).toEqual({ kind: "resolving" });
    expect(steadySeatThread(null, linked, loading)).toEqual({ kind: "resolving" });
    expect(steadySeatThread(null, linked, loaded)).toEqual({ kind: "shown", seat: linked });
    expect(steadySeatThread(null, direct, loaded)).toEqual({ kind: "shown", seat: direct });
    // This client's own connection needs no link, so it never waits.
    expect(steadySeatThread(null, direct, online)).toEqual({ kind: "shown", seat: direct });
    // Another seat opened over this one is placed afresh, not swapped in under the old view.
    const other = { ...direct, threadId: ThreadId.make("child-z") };
    expect(steadySeatThread(other, direct, loading)).toEqual({ kind: "resolving" });
  });

  it("keeps the direct view through a reconnect, and offers the linked view for later", () => {
    // The connection drops: the links are asked for, and until they answer nothing changes.
    expect(steadySeatThread(direct, direct, loading)).toEqual({ kind: "shown", seat: direct });
    // They answer that a link exists. The direct view stays; the linked view waits its turn.
    expect(steadySeatThread(direct, linked, loaded)).toEqual({
      kind: "shown",
      seat: direct,
      later: linked,
    });
    // The connection is back before that turn comes: nothing was remounted.
    expect(steadySeatThread(direct, direct, online)).toEqual({ kind: "shown", seat: direct });
  });

  it("leaves the linked view at once for a connection of its own, not for links that reload", () => {
    expect(steadySeatThread(linked, direct, online)).toEqual({ kind: "shown", seat: direct });
    expect(steadySeatThread(linked, direct, loading)).toEqual({ kind: "shown", seat: linked });
    // The link is really gone and the environment is saved: it opens in place, offline.
    expect(steadySeatThread(linked, direct, loaded)).toEqual({ kind: "shown", seat: direct });
    // A new name for the linked environment redraws the same view.
    const renamed = { ...linked, linked: { ...linked.linked, label: "Workstation" } };
    expect(steadySeatThread(linked, renamed, loaded)).toEqual({ kind: "shown", seat: renamed });
  });

  it("shows nothing once the seat is closed", () => {
    expect(steadySeatThread(direct, null, online)).toEqual({ kind: "none" });
  });

  it("keeps a seat open in place when its saved environment goes offline and nothing links to it", () => {
    const children = [
      {
        childThreadId: null,
        remoteChild: { environmentId: remote, threadId: direct.threadId, label: "Desktop" },
        teamChat: { seat: "remote-qa" },
      },
    ];
    // What the connections say at each step, for a saved environment no link reaches.
    const resolved = (connected: boolean) =>
      openSeatThread(ref, children, direct, {
        ownConnection: () => ({ connected }),
        isLinked: () => false,
      });
    const open = steadySeatThread(null, resolved(true), online);
    expect(open).toEqual({ kind: "shown", seat: direct });
    // Offline: the same view stays, where the app says it is offline and can reconnect. There
    // is no linked view to move to, however long it lasts, and coming back changes nothing.
    for (const reach of [loading, loaded]) {
      expect(steadySeatThread(direct, resolved(false), reach)).toEqual(open);
    }
    expect(steadySeatThread(direct, resolved(true), online)).toEqual(open);
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
