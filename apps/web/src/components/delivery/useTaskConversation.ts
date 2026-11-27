import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { SideThreadOpenIntent } from "@t3tools/client-runtime/side-thread";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent } from "react";

import type { TaskView } from "../../lib/delivery";
import { openLinkedThreadRead, openSideThread } from "../../lib/sideChatPane";
import {
  conversationState,
  seatChildrenWithAttestations,
  seatConversation,
  seatEnvironmentsNeedingLinks,
  seatLinksRefreshKey,
  seatThreadRows,
  taskConversation,
  type SeatReach,
  type SeatThread,
} from "../../lib/taskConversation";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { useQuietThreadProjection } from "../../state/entities";
import {
  offersLinkedEnvironmentsAtom,
  peerLinkEnvironment,
  useLinkedEnvironmentsRead,
} from "../../state/peerLinks";
import { buildThreadRouteParams } from "../../threadRoutes";

const NO_CHILDREN: ReadonlyArray<never> = [];
const offersNoLinksAtom = Atom.make(false).pipe(Atom.withLabel("delivery:seat-links:none"));

/**
 * Opens a seat's conversation the way a subagent row of `host` opens its thread: beside it or at
 * the thread's own route, as the click asks. A seat on a machine this client is not connected to
 * opens read-only through `host`'s environment, as a remote subagent row does.
 */
export function useOpenSeatThread(host: ScopedThreadRef | null) {
  const navigate = useNavigate();
  return (target: SeatThread, title: string, intent: SideThreadOpenIntent) => {
    if (target.linked) {
      openLinkedThreadRead({
        panelRef: host,
        target: {
          viaEnvironmentId: target.linked.viaEnvironmentId,
          environmentId: target.environmentId,
          threadId: target.threadId,
          label: target.linked.label,
          title,
        },
        intent,
        navigate,
      });
      return;
    }
    openSideThread({
      threadRef: { environmentId: target.environmentId, threadId: target.threadId },
      panelRef: host,
      intent,
      navigate: (threadRef) =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        }),
    });
  };
}

/**
 * The task's conversation for the task view: what the centre shows, and the seats' own
 * conversations, which open as the task thread's subagent rows do. Everything the engine does not
 * tell us yet is read through `lib/taskConversation`, so this is the only hook the view needs.
 */
export function useTaskConversation(task: TaskView | null) {
  const conversation = task ? taskConversation(task) : ({ kind: "none", why: "unlinked" } as const);
  const ref = conversation.kind === "thread" ? conversation.ref : null;
  const environment = useEnvironment(ref?.environmentId ?? null);
  const reachable = environment?.connection.phase === "connected";
  const projected = useQuietThreadProjection(ref)?.projection.subagents ?? NO_CHILDREN;
  const children = seatChildrenWithAttestations(ref, projected, task?.council?.seats);
  const { presentationById } = useEnvironments();
  const ownConnection = (id: EnvironmentId) => {
    const own = presentationById.get(id);
    return own && { connected: own.connection.phase === "connected" };
  };
  // Links are read only while a seat runs somewhere this client is not connected to.
  const wanted = seatEnvironmentsNeedingLinks(children, ownConnection);
  const linksHost = ref !== null && wanted.length > 0 ? ref.environmentId : null;
  const links = useLinkedEnvironmentsRead(linksHost);
  const offered = useAtomValue(
    linksHost === null ? offersNoLinksAtom : offersLinkedEnvironmentsAtom(linksHost),
  );
  const registry = useContext(RegistryContext);
  const queried = offered ? linksHost : null;
  const refreshKey = seatLinksRefreshKey(queried, wanted);
  const refreshLacking = useEffectEvent(() => {
    if (queried !== null) peerLinkEnvironment.refreshNamesLacking(registry, queried, wanted);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- links made outside this client are not pushed, so a seat on a machine the names lack asks the server again
  useEffect(() => {
    if (refreshKey !== "") refreshLacking();
  }, [refreshKey]);
  const reach: SeatReach = { ownConnection, isLinked: (id) => links.names.has(id) };
  const seats = task?.council?.seats ?? [];
  const thread = (name: string) =>
    seatConversation(
      ref,
      children,
      name,
      reach,
      seats.find((item) => item.seat === name)?.threadId ?? null,
    );

  return {
    state: conversationState(conversation, reachable),
    ref,
    seats: { thread, rows: seatThreadRows(ref, projected, seats, thread) },
  };
}
