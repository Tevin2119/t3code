import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { create } from "zustand";

import type { TaskView } from "../../lib/delivery";
import {
  conversationState,
  openSeatThread,
  sameSeatView,
  sameThread,
  seatConversation,
  seatOfThread,
  steadySeatThread,
  taskConversation,
  type SeatCertainty,
  type SeatReach,
  type SeatThread,
} from "../../lib/taskConversation";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { useQuietThreadProjection } from "../../state/entities";
import { useLinkedEnvironmentsRead } from "../../state/peerLinks";

const NO_CHILDREN: ReadonlyArray<never> = [];

/**
 * How long this client's connection to a seat's environment may stay down before the open seat
 * moves to the read-only view through the link. A reconnect is usually over well inside it.
 */
export const SEAT_LINKED_VIEW_DELAY_MS = 10_000;

const seatViewKey = (seat: SeatThread) =>
  `${seat.environmentId}:${seat.threadId}:${seat.linked?.viaEnvironmentId ?? ""}`;

/**
 * The seat conversation open in a task's centre, by task. The board's column opens one as the
 * centre's own rows do, so both read and write it here; the task view forgets it when it closes.
 */
const useOpenSeats = create<{
  readonly byTask: Readonly<Record<string, ScopedThreadRef>>;
  readonly set: (task: string, seat: ScopedThreadRef | null) => void;
}>((set) => ({
  byTask: {},
  set: (task, seat) =>
    set((state) => {
      const { [task]: _closed, ...rest } = state.byTask;
      return { byTask: seat ? { ...rest, [task]: seat } : rest };
    }),
}));

const openSeatKey = (environmentId: EnvironmentId | null, taskId: string) =>
  JSON.stringify([environmentId, taskId]);

/** Closes the seat open in a task's centre, so the task opens on its own conversation next time. */
export const forgetOpenSeat = (environmentId: EnvironmentId | null, taskId: string) =>
  useOpenSeats.getState().set(openSeatKey(environmentId, taskId), null);

/**
 * The seat the centre shows, held steady while the links load and through a short reconnect: see
 * `steadySeatThread`. `resolving` is a seat that was opened and cannot be placed yet.
 */
export function useSteadySeat(
  resolved: SeatThread | null,
  reach: SeatCertainty,
): { readonly seat: SeatThread | null; readonly resolving: boolean } {
  const [shown, setShown] = useState<SeatThread | null>(null);
  // The view whose wait is over. Kept by key, so a wait that ended for one view moves no other.
  const [waitedFor, setWaitedFor] = useState<string | null>(null);
  const steady = steadySeatThread(shown, resolved, reach);
  const later = steady.kind === "shown" ? (steady.later ?? null) : null;
  const laterKey = later === null ? null : seatViewKey(later);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer: the linked view replaces the direct one only after the connection has stayed down this long
  useEffect(() => {
    if (laterKey === null) return;
    const timer = setTimeout(() => setWaitedFor(laterKey), SEAT_LINKED_VIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [laterKey]);
  const seat =
    steady.kind !== "shown" ? null : later !== null && waitedFor === laterKey ? later : steady.seat;
  if (!sameSeatView(seat, shown)) setShown(seat);
  if (laterKey === null && waitedFor !== null) setWaitedFor(null);
  return { seat, resolving: steady.kind === "resolving" };
}

/**
 * The task's conversation for the task view: what the centre shows, which seat conversation is
 * open in it, and the seat rows that open one. Everything the engine does not tell us yet is read
 * through `lib/taskConversation`, so this is the only hook the view needs.
 */
export function useTaskConversation(environmentId: EnvironmentId | null, task: TaskView | null) {
  const conversation = task ? taskConversation(task) : ({ kind: "none", why: "unlinked" } as const);
  const ref = conversation.kind === "thread" ? conversation.ref : null;
  const environment = useEnvironment(ref?.environmentId ?? null);
  const reachable = environment?.connection.phase === "connected";
  const children = useQuietThreadProjection(ref)?.projection.subagents ?? NO_CHILDREN;
  const { presentationById } = useEnvironments();
  const ownConnection = (id: EnvironmentId) => {
    const own = presentationById.get(id);
    return own && { connected: own.connection.phase === "connected" };
  };
  // Links are read only while a seat runs somewhere this client is not connected to.
  const links = useLinkedEnvironmentsRead(
    ref !== null &&
      children.some(
        (child) =>
          child.childThreadId === null &&
          child.remoteChild !== undefined &&
          ownConnection(child.remoteChild.environmentId)?.connected !== true,
      )
      ? ref.environmentId
      : null,
  );
  const reach: SeatReach = { ownConnection, isLinked: (id) => links.names.has(id) };
  const seatKey = task ? openSeatKey(environmentId, task.id) : null;
  const opened = useOpenSeats((state) => (seatKey ? (state.byTask[seatKey] ?? null) : null));
  const setSeat = (thread: ScopedThreadRef | null) => {
    if (seatKey) useOpenSeats.getState().set(seatKey, thread);
  };
  const resolved = openSeatThread(ref, children, opened, reach);
  const connected = resolved !== null && ownConnection(resolved.environmentId)?.connected === true;
  const { seat, resolving } = useSteadySeat(resolved, {
    connected,
    // A seat in the task's own environment needs no link, and an environment that is not
    // reachable cannot be asked for its links, nor read through one.
    certain:
      connected || resolved?.environmentId === ref?.environmentId || links.settled || !reachable,
  });
  // A seat still being placed is the open one, so its row and its name do not wait.
  const current: SeatThread | null = seat ?? (resolving ? opened : null);

  // A seat's thread, or the task's own: what a lineage link or a seat row asks to open.
  const open = (thread: ScopedThreadRef) => setSeat(sameThread(thread, ref) ? null : thread);

  return {
    state: conversationState(conversation, reachable),
    ref,
    seat,
    /** A seat is open but cannot be placed yet: the centre waits instead of showing the task. */
    seatResolving: resolving,
    seatName: seatOfThread(ref, children, current, task?.council?.seats),
    open,
    backToTask: () => setSeat(null),
    seats: {
      thread: (name: string) =>
        seatConversation(
          ref,
          children,
          name,
          reach,
          task?.council?.seats.find((item) => item.seat === name)?.threadId ?? null,
        ),
      current,
      open,
    },
  };
}
