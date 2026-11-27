import {
  subagentThreadTarget,
  type SubagentThreadTarget,
} from "@t3tools/client-runtime/linked-thread";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { BOARD_LANE, boardLaneOf } from "./boardLanes";
import type { CouncilSeat, DeliveryCard, TaskView } from "./delivery";

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

export function seatChildrenWithAttestations(
  conversation: ScopedThreadRef | null,
  children: ReadonlyArray<SeatChild>,
  seats: ReadonlyArray<Pick<CouncilSeat, "seat" | "seatThread">> | undefined,
): ReadonlyArray<SeatChild> {
  if (!conversation || !seats) return children;
  const attested = seats.flatMap(({ seat, seatThread }): SeatChild[] => {
    if (!seatThread) return [];
    const target = {
      environmentId: EnvironmentId.make(seatThread.environmentId),
      threadId: ThreadId.make(seatThread.threadId),
    };
    const latest = children.findLast(
      (child) =>
        child.teamChat?.seat === seat &&
        (child.childThreadId !== null || child.remoteChild !== undefined),
    );
    if (latest && isChildThread(conversation, latest, target)) {
      return [];
    }
    return [
      target.environmentId === conversation.environmentId
        ? { childThreadId: target.threadId, teamChat: { seat } }
        : {
            childThreadId: null,
            remoteChild: { ...target, label: target.environmentId },
            teamChat: { seat },
          },
    ];
  });
  return attested.length ? [...children, ...attested] : children;
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
 * The environments of seats that run where this client is not connected, so they open only
 * through a link. The link names are read while there is one, and reread when they lack one.
 */
export function seatEnvironmentsNeedingLinks(
  children: ReadonlyArray<SeatChild>,
  ownConnection: SeatReach["ownConnection"],
): ReadonlyArray<EnvironmentId> {
  const wanted = new Set<EnvironmentId>();
  for (const child of children) {
    if (child.childThreadId !== null || child.remoteChild === undefined) continue;
    if (ownConnection(child.remoteChild.environmentId)?.connected === true) continue;
    wanted.add(child.remoteChild.environmentId);
  }
  return [...wanted];
}

/**
 * When a reread of `host`'s link names for `wanted` is due again: the same machines in another
 * order are the same ask. Empty when there is nothing to ask.
 */
export const seatLinksRefreshKey = (
  host: EnvironmentId | null,
  wanted: ReadonlyArray<EnvironmentId>,
): string =>
  host === null || wanted.length === 0 ? "" : JSON.stringify([host, wanted.toSorted()]);

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
const isChildThread = (conversation: ScopedThreadRef, child: SeatChild, thread: ScopedThreadRef) =>
  child.childThreadId !== null
    ? child.childThreadId === thread.threadId && conversation.environmentId === thread.environmentId
    : child.remoteChild?.threadId === thread.threadId &&
      child.remoteChild.environmentId === thread.environmentId;

/** A seat's conversation as a row of the task thread's lineage: the seat, its work, where it opens. */
export interface SeatThreadRow {
  readonly seat: string;
  readonly activity: string;
  readonly target: SeatThread;
}

/**
 * The seats whose conversations the task thread's lineage does not list itself. A child T3 spawned
 * is already a subagent row of the thread, so only the engine's own seat threads are added.
 */
export function seatThreadRows(
  conversation: ScopedThreadRef | null,
  listed: ReadonlyArray<SeatChild>,
  seats: ReadonlyArray<Pick<CouncilSeat, "seat" | "activity">>,
  thread: (seat: string) => SeatThread | null,
): ReadonlyArray<SeatThreadRow> {
  if (!conversation) return [];
  return seats.flatMap(({ seat, activity }) => {
    const target = thread(seat);
    if (!target || listed.some((child) => isChildThread(conversation, child, target))) return [];
    return [{ seat, activity, target }];
  });
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
