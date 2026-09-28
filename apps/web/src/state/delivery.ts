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

/** Whether the person chose for this thread, as opposed to the default standing in. */
export function hasDraftTeamChoice(threadId: string): boolean {
  return threadId in useDeliveryDraftStore.getState().choices;
}

export function useDraftTeamChoice(threadId: string | null): DraftTeamChoice {
  return useDeliveryDraftStore((state) =>
    threadId ? (state.choices[threadId] ?? DEFAULT_DRAFT_TEAM_CHOICE) : DEFAULT_DRAFT_TEAM_CHOICE,
  );
}

export type SeatChoice = Partial<Record<"model" | "reasoning" | "access", string>>;

/** A workflow being prepared in the composer. It is saved to the engine as a draft. */
export interface OrchestratorDraft {
  readonly team: string;
  readonly workflow: string;
  readonly seats: Readonly<Record<string, SeatChoice>>;
  /** The engine's id for the draft, once it has been saved there. */
  readonly engineThread: string | null;
  /** The text as it was when last saved, to tell a saved draft from a changed one. */
  readonly savedText: string | null;
}

interface OrchestratorDraftState {
  /** Threads whose composer is in Orchestrator mode, with what was chosen there. */
  readonly drafts: Record<string, OrchestratorDraft>;
  /** Counts requests to save, so the composer's controls can act on the send key. */
  readonly saveRequests: Record<string, number>;
  readonly enter: (threadId: string) => void;
  readonly leave: (threadId: string) => void;
  readonly update: (threadId: string, patch: Partial<OrchestratorDraft>) => void;
  readonly setSeat: (threadId: string, seat: string, choice: SeatChoice) => void;
  readonly requestSave: (threadId: string) => void;
}

const NEW_ORCHESTRATOR_DRAFT: OrchestratorDraft = {
  team: DELIVERY_DEFAULT_TEAM,
  workflow: "standard",
  seats: {},
  engineThread: null,
  savedText: null,
};

export const useOrchestratorDraftStore = create<OrchestratorDraftState>()(
  persist(
    (set) => ({
      drafts: {},
      saveRequests: {},
      enter: (threadId) =>
        set((state) =>
          threadId in state.drafts
            ? state
            : { drafts: { ...state.drafts, [threadId]: NEW_ORCHESTRATOR_DRAFT } },
        ),
      leave: (threadId) =>
        set((state) => {
          if (!(threadId in state.drafts)) return state;
          const { [threadId]: _removed, ...rest } = state.drafts;
          return { drafts: rest };
        }),
      update: (threadId, patch) =>
        set((state) => {
          const current = state.drafts[threadId];
          if (!current) return state;
          // Settings made for one team's seats mean nothing for another's.
          const seats =
            patch.team !== undefined && patch.team !== current.team && patch.seats === undefined
              ? {}
              : (patch.seats ?? current.seats);
          return { drafts: { ...state.drafts, [threadId]: { ...current, ...patch, seats } } };
        }),
      setSeat: (threadId, seat, choice) =>
        set((state) => {
          const current = state.drafts[threadId];
          if (!current) return state;
          const merged = Object.fromEntries(
            Object.entries({ ...current.seats[seat], ...choice }).filter(
              ([, value]) => typeof value === "string" && value !== "",
            ),
          );
          const { [seat]: _previous, ...others } = current.seats;
          const seats = Object.keys(merged).length > 0 ? { ...others, [seat]: merged } : others;
          return { drafts: { ...state.drafts, [threadId]: { ...current, seats } } };
        }),
      requestSave: (threadId) =>
        set((state) => ({
          saveRequests: {
            ...state.saveRequests,
            [threadId]: (state.saveRequests[threadId] ?? 0) + 1,
          },
        })),
    }),
    {
      name: "t3code:delivery-orchestrator-drafts:v1",
      partialize: (state) => ({ drafts: state.drafts }),
    },
  ),
);

export function isOrchestratorDraft(threadId: string): boolean {
  return threadId in useOrchestratorDraftStore.getState().drafts;
}

export function useOrchestratorDraft(threadId: string | null): OrchestratorDraft | null {
  return useOrchestratorDraftStore((state) => (threadId ? (state.drafts[threadId] ?? null) : null));
}
