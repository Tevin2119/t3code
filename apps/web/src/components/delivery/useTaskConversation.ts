import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import type { TaskView } from "../../lib/delivery";
import {
  conversationState,
  openSeatThread,
  sameThread,
  seatConversation,
  seatOfThread,
  taskConversation,
  type SeatReach,
  type SeatThread,
} from "../../lib/taskConversation";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { useQuietThreadProjection } from "../../state/entities";
import { useLinkedEnvironments } from "../../state/peerLinks";

const NO_CHILDREN: ReadonlyArray<never> = [];

/**
 * The task's conversation for the task view: what the centre shows, which seat conversation is
 * open in it, and the seat rows that open one. Everything the engine does not tell us yet is read
 * through `lib/taskConversation`, so this is the only hook the view needs.
 */
export function useTaskConversation(task: TaskView | null) {
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
  const links = useLinkedEnvironments(
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
  const reach: SeatReach = { ownConnection, isLinked: (id) => links.has(id) };
  const [opened, setSeat] = useState<ScopedThreadRef | null>(null);
  const seat: SeatThread | null = openSeatThread(ref, children, opened, reach);

  // A seat's thread, or the task's own: what a lineage link or a seat row asks to open.
  const open = (thread: ScopedThreadRef) => setSeat(sameThread(thread, ref) ? null : thread);

  return {
    state: conversationState(conversation, reachable),
    ref,
    seat,
    seatName: seatOfThread(ref, children, seat),
    open,
    backToTask: () => setSeat(null),
    seats: {
      thread: (name: string) => seatConversation(ref, children, name, reach),
      current: seat,
      open,
    },
  };
}
