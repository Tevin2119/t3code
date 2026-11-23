import {
  subagentThreadTarget,
  type SubagentThreadTarget,
} from "@t3tools/client-runtime/linked-thread";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { BOARD_LANE, boardLaneOf } from "./boardLanes";
import type { DeliveryCard, TaskView } from "./delivery";

/**
 * The one place that says which conversation is a task's: the thread the engine links it to
 * (`boardThread`). Nothing else reads that field, and the thread a task was filed from
 * (`task.source`) is never a task's conversation.
 */

/** What a task's conversation is, before anyone asks whether it can be reached. */
export type TaskConversation =
  | { readonly kind: "thread"; readonly ref: ScopedThreadRef }
  /**
   * `draft` and `queued` have no conversation yet; `unlinked` is a task in work with none known;
   * `moved` is worked on another machine, or on its way there, so none is opened here.
   */
  | { readonly kind: "none"; readonly why: "draft" | "queued" | "unlinked" | "moved" };

type ConversationInput = Pick<TaskView, "boardThread" | "isDraft" | "lane" | "state">;

/**
 * The engine's link is the conversation, wherever the task stands: a task sent back to the queue
 * keeps what was said in it. A task the engine reports moved or moving opens none here, link or
 * not. With no link a draft or a queued task has none yet, and a task in work is `unlinked`.
 */
export function taskConversation(task: ConversationInput): TaskConversation {
  if (task.state === "moved" || task.state === "moving") return { kind: "none", why: "moved" };
  const link = task.boardThread;
  if (link) {
    return {
      kind: "thread",
      ref: {
        environmentId: EnvironmentId.make(link.environmentId),
        threadId: ThreadId.make(link.threadId),
      },
    };
  }
  if (task.isDraft || task.lane === "draft") return { kind: "none", why: "draft" };
  if (boardLaneOf(task.lane) === BOARD_LANE.queue) return { kind: "none", why: "queued" };
  return { kind: "none", why: "unlinked" };
}

/** What the centre of the task view shows. */
export type ConversationState =
  /** `offline`: T3 is not running. The thread stays mounted either way: unmounting its composer while the connection churns throws. */
  | { readonly kind: "open"; readonly ref: ScopedThreadRef; readonly offline: boolean }
  /** No conversation yet, and none expected until the task starts. No composer. */
  | { readonly kind: "waiting"; readonly why: "draft" | "queued" }
  /** In work with no linked conversation: the engine's own log stands in, as it did before. */
  | { readonly kind: "unlinked" }
  /** Worked on another machine: no thread is mounted and nothing is sent from here. */
  | { readonly kind: "moved" };

export function conversationState(
  conversation: TaskConversation,
  reachable: boolean,
): ConversationState {
  if (conversation.kind === "thread") {
    return { kind: "open", ref: conversation.ref, offline: !reachable };
  }
  if (conversation.why === "moved") return { kind: "moved" };
  return conversation.why === "unlinked"
    ? { kind: "unlinked" }
    : { kind: "waiting", why: conversation.why };
}

export const sameThread = (a: ScopedThreadRef | null, b: ScopedThreadRef | null): boolean =>
  a !== null && b !== null && a.environmentId === b.environmentId && a.threadId === b.threadId;

/** A seat's conversation, in the shape every agent row opens: see `subagentThreadTarget`. */
export type SeatThread = SubagentThreadTarget;

/** The part of a delegated child this module reads: its thread, here or remote, and its seat. */
interface SeatChild {
  readonly childThreadId: ThreadId | null;
  readonly remoteChild?:
    | {
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId;
        readonly label: string;
      }
    | undefined;
  readonly teamChat?: { readonly seat: string } | undefined;
}

/** What places a seat that runs in a linked environment: see `subagentThreadTarget`. */
export interface SeatReach {
  readonly ownConnection: (
    environmentId: EnvironmentId,
  ) => { readonly connected: boolean } | undefined;
  readonly isLinked: (environmentId: EnvironmentId) => boolean;
}

const LOCAL_ONLY: SeatReach = { ownConnection: () => undefined, isLinked: () => false };

/**
 * The child conversation of a seat. In an orchestrator team chat the lead hands each seat a
 * delegated child thread named by the seat (`teamChat.seat`), the model this slice copies. Without
 * one, the engine's thread for the seat in the task's environment; a seat with neither opens none.
 * A seat that runs in a linked environment opens there, or read-only through the task's (`linked`).
 */
export function seatConversation(
  conversation: ScopedThreadRef | null,
  children: ReadonlyArray<SeatChild>,
  seat: string,
  reach: SeatReach = LOCAL_ONLY,
  engineThreadId: string | null = null,
): SeatThread | null {
  if (!conversation) return null;
  const child =
    children.findLast(
      (item) =>
        item.teamChat?.seat === seat &&
        (item.childThreadId !== null || item.remoteChild !== undefined),
    ) ?? (engineThreadId ? { childThreadId: ThreadId.make(engineThreadId) } : undefined);
  return child === undefined
    ? null
    : subagentThreadTarget(child, conversation.environmentId, reach.ownConnection, reach.isLinked);
}

// A thread id alone names no thread: the same id can exist in two environments.
const childOfThread = (
  conversation: ScopedThreadRef,
  children: ReadonlyArray<SeatChild>,
  thread: ScopedThreadRef,
) =>
  children.find((item) =>
    item.childThreadId !== null
      ? item.childThreadId === thread.threadId &&
        conversation.environmentId === thread.environmentId
      : item.remoteChild?.threadId === thread.threadId &&
        item.remoteChild.environmentId === thread.environmentId,
  );

/**
 * The seat a child thread was given, for the line above a seat conversation. A thread the engine
 * names for a seat, in the task's environment, is that seat's as much as one T3 spawned.
 */
export function seatOfThread(
  conversation: ScopedThreadRef | null,
  children: ReadonlyArray<SeatChild>,
  thread: ScopedThreadRef | null,
  engineSeats: ReadonlyArray<{ readonly seat: string; readonly threadId: string | null }> = [],
): string | null {
  if (!conversation || !thread) return null;
  const spawned = childOfThread(conversation, children, thread)?.teamChat?.seat;
  if (spawned) return spawned;
  if (thread.environmentId !== conversation.environmentId) return null;
  return engineSeats.find((item) => item.threadId === thread.threadId)?.seat ?? null;
}

/** How an open thread is reached now, so a connection made or lost while it is open shows. */
export function openSeatThread(
  conversation: ScopedThreadRef | null,
  children: ReadonlyArray<SeatChild>,
  thread: ScopedThreadRef | null,
  reach: SeatReach,
): SeatThread | null {
  if (!conversation || !thread) return thread;
  const child = childOfThread(conversation, children, thread);
  const target =
    child &&
    subagentThreadTarget(child, conversation.environmentId, reach.ownConnection, reach.isLinked);
  return target ?? thread;
}

/** Whether the open seat reads through a link (`linked`) or in its own environment (`direct`). */
const seatMode = (seat: SeatThread) => (seat.linked === undefined ? "direct" : "linked");

/** Two targets that draw the same view: swapping one for the other remounts nothing. */
export const sameSeatView = (a: SeatThread | null, b: SeatThread | null): boolean =>
  a === b ||
  (sameThread(a, b) &&
    a?.linked?.viaEnvironmentId === b?.linked?.viaEnvironmentId &&
    a?.linked?.label === b?.linked?.label);

/** What the centre does with the seat a person opened. */
export type SteadySeat =
  | { readonly kind: "none" }
  /** Opened, but how to reach it is not known yet. Nothing is mounted, so nothing is swapped. */
  | { readonly kind: "resolving" }
  /**
   * `later` is the read-only view to move to if this client's connection stays down. Until
   * then the direct view stays, which says it is offline and keeps its composer and scroll.
   */
  | { readonly kind: "shown"; readonly seat: SeatThread; readonly later?: SeatThread };

/** What decides whether an open seat's view may change now. */
export interface SeatCertainty {
  /** The answer does not rest on links that have not loaded yet. */
  readonly certain: boolean;
  /** This client's own connection to the seat's environment is up. */
  readonly connected: boolean;
}

/**
 * Holds an open seat's view steady: the direct and the linked view are two components, so a swap
 * remounts the conversation. `resolved` is what `openSeatThread` says now, which changes while
 * links load and during a reconnect; `shown` is what the centre shows.
 */
export function steadySeatThread(
  shown: SeatThread | null,
  resolved: SeatThread | null,
  reach: SeatCertainty,
): SteadySeat {
  if (resolved === null) return { kind: "none" };
  if (shown === null || !sameThread(shown, resolved)) {
    return reach.certain ? { kind: "shown", seat: resolved } : { kind: "resolving" };
  }
  if (seatMode(shown) === seatMode(resolved)) return { kind: "shown", seat: resolved };
  if (seatMode(shown) === "direct") return { kind: "shown", seat: shown, later: resolved };
  return { kind: "shown", seat: reach.connected || reach.certain ? resolved : shown };
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
