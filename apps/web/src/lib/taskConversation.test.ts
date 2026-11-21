import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  conversationState,
  queueWait,
  openSeatThread,
  seatConversation,
  seatOfThread,
  taskConversation,
} from "./taskConversation";

const source = { kind: "thread" as const, environmentId: "env-1", threadId: "thread-1" };
const ref = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") };

describe("which conversation a task has", () => {
  it("is the thread the task was made from, once the task is in work", () => {
    expect(taskConversation({ source, isDraft: false, lane: "implementation" })).toEqual({
      kind: "thread",
      ref,
    });
  });

  it("has none for a draft or a queued task, even when it was made from a thread", () => {
    expect(taskConversation({ source, isDraft: true, lane: "draft" })).toEqual({
      kind: "none",
      why: "draft",
    });
    for (const lane of ["intake", "ready", "queue"]) {
      expect(taskConversation({ source, isDraft: false, lane })).toEqual({
        kind: "none",
        why: "queued",
      });
    }
  });

  it("is unlinked for a task in work that was not made from a thread", () => {
    expect(taskConversation({ source: null, isDraft: false, lane: "planning" })).toEqual({
      kind: "none",
      why: "unlinked",
    });
  });
});

describe("what the centre shows", () => {
  const conversation = { kind: "thread" as const, ref };

  it("keeps the thread open, and says whether T3 is running", () => {
    expect(conversationState(conversation, true)).toEqual({ kind: "open", ref, offline: false });
    expect(conversationState(conversation, false)).toEqual({ kind: "open", ref, offline: true });
  });

  it("keeps a task with no conversation waiting or unlinked, whether or not T3 is running", () => {
    expect(conversationState({ kind: "none", why: "queued" }, false)).toEqual({
      kind: "waiting",
      why: "queued",
    });
    expect(conversationState({ kind: "none", why: "unlinked" }, true)).toEqual({
      kind: "unlinked",
    });
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
