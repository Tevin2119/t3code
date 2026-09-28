import { createDeliveryEnvironmentAtoms } from "@t3tools/client-runtime/state/delivery";
import { DELIVERY_DEFAULT_TEAM, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { isStaleReading } from "../lib/delivery";
import { useEnvironmentQuery } from "./query";

export const deliveryEnvironment = createDeliveryEnvironmentAtoms(connectionAtomRuntime);

/** Whether this environment has a delivery engine turned on. */
export function useDeliveryEnabled(environmentId: EnvironmentId | null): boolean {
  return useEnvironmentSettings(
    // A disconnected environment reads defaults, where delivery is off.
    (environmentId ?? "") as EnvironmentId,
    (settings) => settings.delivery?.enabled === true,
  );
}

/**
 * Reads an engine path through the server. With `pollMs` the reading is
 * refreshed while the component is mounted and the page is visible, since a
 * team works for minutes and the engine has no push channel yet.
 */
export function useDeliveryRead(
  environmentId: EnvironmentId | null,
  path: string | null,
  options: { readonly pollMs?: number } = {},
) {
  const atom = useMemo(
    () =>
      environmentId && path
        ? deliveryEnvironment.read({ environmentId, input: { path: path as never } })
        : null,
    [environmentId, path],
  );
  const query = useEnvironmentQuery(atom);
  const { refresh } = query;
  const pollMs = options.pollMs;
  useEffect(() => {
    if (!atom || !pollMs) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [atom, pollMs, refresh]);
  return {
    body: query.data?.body ?? null,
    readAt: query.data?.readAt ?? null,
    error: query.error,
    isPending: query.isPending,
    refresh,
  };
}

/** Whether a reading is old enough to say so. Rechecked on a slow clock, not on every render. */
export function useStaleReading(readAt: string | null): boolean {
  // The clock only moves forward on its timer. A fresh reading is newer than the clock, so it
  // is never taken for stale, and an old one turns stale within five seconds.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  return isStaleReading(readAt, now);
}

export interface DraftTeamChoice {
  /** Null is "No team": the thread starts as an ordinary one. */
  readonly team: string | null;
  readonly role: string | null;
}

interface DeliveryDraftState {
  readonly choices: Record<string, DraftTeamChoice>;
  readonly setChoice: (threadId: string, choice: DraftTeamChoice) => void;
  readonly clearChoice: (threadId: string) => void;
}

/** The team chosen for a thread that has not been sent yet. Kept across reloads. */
export const useDeliveryDraftStore = create<DeliveryDraftState>()(
  persist(
    (set) => ({
      choices: {},
      setChoice: (threadId, choice) =>
        set((state) => ({ choices: { ...state.choices, [threadId]: choice } })),
      clearChoice: (threadId) =>
        set((state) => {
          if (!(threadId in state.choices)) return state;
          const { [threadId]: _removed, ...rest } = state.choices;
          return { choices: rest };
        }),
    }),
    { name: "t3code:delivery-draft-teams:v1" },
  ),
);

export const DEFAULT_DRAFT_TEAM_CHOICE: DraftTeamChoice = {
  team: DELIVERY_DEFAULT_TEAM,
  role: null,
};

/** A new thread is in the default team unless the person chose otherwise. */
export function readDraftTeamChoice(threadId: string): DraftTeamChoice {
  return useDeliveryDraftStore.getState().choices[threadId] ?? DEFAULT_DRAFT_TEAM_CHOICE;
}

export function useDraftTeamChoice(threadId: string | null): DraftTeamChoice {
  return useDeliveryDraftStore((state) =>
    threadId ? (state.choices[threadId] ?? DEFAULT_DRAFT_TEAM_CHOICE) : DEFAULT_DRAFT_TEAM_CHOICE,
  );
}
