import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  conversationState,
  queueWait,
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
  const children = [
    { childThreadId: "child-a", teamChat: { seat: "builder" } },
    { childThreadId: "child-b", teamChat: { seat: "qa" } },
    { childThreadId: "child-c", teamChat: { seat: "builder" } },
    { childThreadId: null, teamChat: { seat: "reviewer" } },
    { childThreadId: "plain" },
  ];

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

  it("names the seat a child thread was given", () => {
    expect(seatOfThread(children, { ...ref, threadId: ThreadId.make("child-b") })).toBe("qa");
    expect(seatOfThread(children, { ...ref, threadId: ThreadId.make("plain") })).toBeNull();
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
