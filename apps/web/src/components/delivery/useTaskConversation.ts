import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import type { TaskView } from "../../lib/delivery";
import {
  conversationState,
  sameThread,
  seatConversation,
  seatOfThread,
  taskConversation,
} from "../../lib/taskConversation";
import { useEnvironment } from "../../state/environments";
import { useQuietThreadProjection } from "../../state/entities";

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
  const [seat, setSeat] = useState<ScopedThreadRef | null>(null);

  // A seat's thread, or the task's own: what a lineage link or a seat row asks to open.
  const open = (thread: ScopedThreadRef) => setSeat(sameThread(thread, ref) ? null : thread);

  return {
    state: conversationState(conversation, reachable),
    ref,
    seat,
    seatName: seatOfThread(children, seat),
    open,
    backToTask: () => setSeat(null),
    seats: {
      thread: (name: string) => seatConversation(ref, children, name),
      current: seat,
      open,
    },
  };
}
