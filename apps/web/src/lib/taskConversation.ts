import type { ScopedThreadRef } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { BOARD_LANE, boardLaneOf } from "./boardLanes";
import type { DeliveryCard, TaskView } from "./delivery";

/**
 * THROWAWAY, like boardLanes.ts. The one place that says which conversation is a task's, until
 * the engine links tasks to threads (its build slices 1 and 2): an ordinary thread, the one the
 * task was made from, stands in. Callers never read `task.source` themselves.
 */

/** What a task's conversation is, before anyone asks whether it can be reached. */
export type TaskConversation =
  | { readonly kind: "thread"; readonly ref: ScopedThreadRef }
  /** `draft` and `queued` have no conversation yet; `unlinked` is a task in work with none known. */
  | { readonly kind: "none"; readonly why: "draft" | "queued" | "unlinked" };

type ConversationInput = Pick<TaskView, "source" | "isDraft" | "lane">;

/**
 * A draft or a queued task has no conversation, whatever thread it was made from: the thread it
 * came from is a conversation of its own and is not the team's. Once the task is in work the
 * stand-in is that origin thread, if there is one.
 */
export function taskConversation(task: ConversationInput): TaskConversation {
  if (task.isDraft || task.lane === "draft") return { kind: "none", why: "draft" };
  if (boardLaneOf(task.lane) === BOARD_LANE.queue) return { kind: "none", why: "queued" };
  const source = task.source;
  if (!source || !source.environmentId || !source.threadId) {
    return { kind: "none", why: "unlinked" };
  }
  return {
    kind: "thread",
    ref: {
      environmentId: EnvironmentId.make(source.environmentId),
      threadId: ThreadId.make(source.threadId),
    },
  };
}

/** What the centre of the task view shows. */
export type ConversationState =
  /** `offline`: T3 is not running. The thread stays mounted either way: unmounting its composer while the connection churns throws. */
  | { readonly kind: "open"; readonly ref: ScopedThreadRef; readonly offline: boolean }
  /** No conversation yet, and none expected until the task starts. No composer. */
  | { readonly kind: "waiting"; readonly why: "draft" | "queued" }
  /** In work with no known conversation: the engine's own log stands in, as it did before. */
  | { readonly kind: "unlinked" };

export function conversationState(
  conversation: TaskConversation,
  reachable: boolean,
): ConversationState {
  if (conversation.kind === "thread") {
    return { kind: "open", ref: conversation.ref, offline: !reachable };
  }
  return conversation.why === "unlinked"
    ? { kind: "unlinked" }
    : { kind: "waiting", why: conversation.why };
}

export const sameThread = (a: ScopedThreadRef | null, b: ScopedThreadRef | null): boolean =>
  a !== null && b !== null && a.environmentId === b.environmentId && a.threadId === b.threadId;

/** The part of a delegated child the stand-in reads: its thread, and the seat it was given. */
interface SeatChild {
  readonly childThreadId: string | null;
  readonly teamChat?: { readonly seat: string } | undefined;
}

/**
 * The child conversation of a seat. In an orchestrator team chat the lead hands each seat a
 * delegated child thread named by the seat (`teamChat.seat`), the model this slice copies. A seat
 * the lead has not handed work to has none, and its row opens nothing.
 */
export function seatConversation(
  conversation: ScopedThreadRef | null,
  children: ReadonlyArray<SeatChild>,
  seat: string,
): ScopedThreadRef | null {
  if (!conversation) return null;
  const child = children.findLast((item) => item.teamChat?.seat === seat && item.childThreadId);
  return child?.childThreadId
    ? { environmentId: conversation.environmentId, threadId: ThreadId.make(child.childThreadId) }
    : null;
}

/** The seat a child thread was given, for the line above a seat conversation. */
export function seatOfThread(
  children: ReadonlyArray<SeatChild>,
  thread: ScopedThreadRef | null,
): string | null {
  if (!thread) return null;
  return children.find((item) => item.childThreadId === thread.threadId)?.teamChat?.seat ?? null;
}

/**
 * Why a task waits, as the engine reports it on the card. `place` is the engine's own position;
 * without one there is no place to show, and nothing is worked out.
 */
export function queueWait(card: Pick<DeliveryCard, "queue" | "submitted" | "blocker">): {
  readonly place: number | null;
  readonly submitted: boolean;
  readonly blocker: string | null;
} {
  return {
    place: card.queue?.position ?? null,
    submitted: card.submitted !== null,
    blocker: card.blocker ? card.blocker : null,
  };
}
