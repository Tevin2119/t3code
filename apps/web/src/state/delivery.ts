import { createDeliveryEnvironmentAtoms } from "@t3tools/client-runtime/state/delivery";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { DELIVERY_DEFAULT_TEAM, type EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentSettings } from "../hooks/useSettings";
import {
  deliveryFailureProblems,
  deliveryFailureText,
  isStaleReading,
  type SeatChoice,
} from "../lib/delivery";
import { NO_FILTERS, type BoardFilters, type BoardGrouping } from "../lib/deliveryBoard";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export type { SeatChoice };

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

/** The time, for ages shown on cards. Moves once a minute, which is as fine as an age is shown. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export type DeliveryActResult =
  | { readonly ok: true; readonly body: unknown }
  | {
      readonly ok: false;
      readonly why: string;
      /** What the engine listed when it refused, one entry for each thing that is wrong. */
      readonly problems: ReadonlyArray<string>;
    };

/** Asks the engine to do something, and answers with what it said or why it refused. */
export function useDeliveryAct(environmentId: EnvironmentId | null, label: string) {
  const act = useAtomCommand(deliveryEnvironment.act, { label, reportFailure: false });
  return useCallback(
    async (path: string, body: unknown = {}): Promise<DeliveryActResult> => {
      if (!environmentId) {
        return { ok: false, why: "No environment is connected.", problems: [] };
      }
      const result = await act({ environmentId, input: { path: path as never, body } });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        return {
          ok: false,
          why: deliveryFailureText(failure),
          problems: deliveryFailureProblems(failure),
        };
      }
      return { ok: true, body: result.value.body };
    },
    [act, environmentId],
  );
}

/** Reads the engine once, outside of rendering: a piece of a file, for one. */
export function useDeliveryFetch(environmentId: EnvironmentId | null) {
  const read = useAtomCommand(deliveryEnvironment.fetch, {
    label: "delivery read",
    reportFailure: false,
  });
  return useCallback(
    async (path: string): Promise<DeliveryActResult> => {
      if (!environmentId) {
        return { ok: false, why: "No environment is connected.", problems: [] };
      }
      const result = await read({ environmentId, input: { path: path as never } });
      if (result._tag === "Failure") {
        return {
          ok: false,
          why: deliveryFailureText(squashAtomCommandFailure(result)),
          problems: [],
        };
      }
      return { ok: true, body: result.value.body };
    },
    [environmentId, read],
  );
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

/** Replaces what is chosen for a seat, dropping what was set back to the team default. */
export function withSeatChoice(
  seats: Readonly<Record<string, SeatChoice>>,
  seat: string,
  choice: SeatChoice,
): Record<string, SeatChoice> {
  const kept = Object.fromEntries(
    Object.entries(choice).filter(([, value]) => typeof value === "string" && value !== ""),
  );
  const { [seat]: _previous, ...others } = seats;
  return Object.keys(kept).length > 0 ? { ...others, [seat]: kept } : others;
}

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

/** What the composer's controls are doing, for the buttons that stand in the place of Send. */
export interface OrchestratorActivity {
  readonly busy: "save" | "start" | null;
  /** Why the workflow cannot be started now, or null when it can. */
  readonly blocked: string | null;
  readonly team: string | null;
  /** `new` before the first save, then `saved` or `changed`. */
  readonly saved: "new" | "saved" | "changed";
  /** The flow that would be started: a chat, a plan, a review or a delivery. */
  readonly flow: string | null;
}

export const IDLE_ORCHESTRATOR_ACTIVITY: OrchestratorActivity = {
  busy: null,
  blocked: null,
  team: null,
  saved: "new",
  flow: null,
};

interface OrchestratorDraftState {
  /** Threads whose composer is in Orchestrator mode, with what was chosen there. */
  readonly drafts: Record<string, OrchestratorDraft>;
  /** Counts what was asked of the composer's controls, so they can act on it. */
  readonly saveRequests: Record<string, number>;
  readonly startRequests: Record<string, number>;
  readonly activity: Record<string, OrchestratorActivity>;
  readonly enter: (threadId: string) => void;
  readonly leave: (threadId: string) => void;
  readonly update: (threadId: string, patch: Partial<OrchestratorDraft>) => void;
  /** Replaces what is chosen for one seat. */
  readonly setSeat: (threadId: string, seat: string, choice: SeatChoice) => void;
  readonly requestSave: (threadId: string) => void;
  readonly requestStart: (threadId: string) => void;
  readonly setActivity: (threadId: string, activity: OrchestratorActivity) => void;
}

const NEW_ORCHESTRATOR_DRAFT: OrchestratorDraft = {
  team: DELIVERY_DEFAULT_TEAM,
  // Empty until the team is read: the flow is then the one the team runs by default.
  workflow: "",
  seats: {},
  engineThread: null,
  savedText: null,
};

export const useOrchestratorDraftStore = create<OrchestratorDraftState>()(
  persist(
    (set) => ({
      drafts: {},
      saveRequests: {},
      startRequests: {},
      activity: {},
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
          const { [threadId]: _activity, ...activity } = state.activity;
          return { drafts: rest, activity };
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
          const seats = withSeatChoice(current.seats, seat, choice);
          return { drafts: { ...state.drafts, [threadId]: { ...current, seats } } };
        }),
      requestSave: (threadId) =>
        set((state) => ({
          saveRequests: {
            ...state.saveRequests,
            [threadId]: (state.saveRequests[threadId] ?? 0) + 1,
          },
        })),
      requestStart: (threadId) =>
        set((state) => ({
          startRequests: {
            ...state.startRequests,
            [threadId]: (state.startRequests[threadId] ?? 0) + 1,
          },
        })),
      setActivity: (threadId, activity) =>
        set((state) => {
          const current = state.activity[threadId];
          if (
            current &&
            current.busy === activity.busy &&
            current.blocked === activity.blocked &&
            current.team === activity.team &&
            current.flow === activity.flow &&
            current.saved === activity.saved
          ) {
            return state;
          }
          return { activity: { ...state.activity, [threadId]: activity } };
        }),
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

export function useOrchestratorActivity(threadId: string | null): OrchestratorActivity {
  return useOrchestratorDraftStore((state) =>
    threadId
      ? (state.activity[threadId] ?? IDLE_ORCHESTRATOR_ACTIVITY)
      : IDLE_ORCHESTRATOR_ACTIVITY,
  );
}

interface BoardState {
  /** The name written on what this person does: a message, a move, a decision. */
  readonly person: string;
  readonly view: string;
  readonly filters: BoardFilters;
  readonly grouping: BoardGrouping;
  /** Whether the history shows how the engine got somewhere, beside where it got. */
  readonly showDetail: boolean;
  /** Lanes a person folded or opened by hand. A lane not named here is folded while it is empty. */
  readonly laneFolds: Readonly<Record<string, boolean>>;
  readonly setPerson: (person: string) => void;
  readonly setView: (view: string) => void;
  readonly setFilters: (patch: Partial<BoardFilters>) => void;
  readonly clearFilters: () => void;
  readonly setGrouping: (grouping: BoardGrouping) => void;
  readonly setShowDetail: (showDetail: boolean) => void;
  readonly foldLane: (lane: string, folded: boolean) => void;
}

/** How this person looks at the board. Kept across reloads, on this device. */
export const useBoardStore = create<BoardState>()(
  persist(
    (set) => ({
      person: "",
      view: "development",
      filters: NO_FILTERS,
      grouping: "none",
      showDetail: false,
      laneFolds: {},
      setPerson: (person) => set({ person: person.slice(0, 60) }),
      setView: (view) => set({ view }),
      setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
      clearFilters: () => set({ filters: NO_FILTERS }),
      setGrouping: (grouping) => set({ grouping }),
      setShowDetail: (showDetail) => set({ showDetail }),
      foldLane: (lane, folded) =>
        set((state) => ({ laneFolds: { ...state.laneFolds, [lane]: folded } })),
    }),
    {
      name: "t3code:delivery-board:v1",
      version: 1,
      // Before lanes folded by themselves, the folded ones were kept as a list.
      migrate: (kept) => {
        const { collapsedLanes: _collapsed, ...rest } = (kept ?? {}) as Record<string, unknown>;
        return { ...rest, laneFolds: {} };
      },
      // A search is for now. How the board is laid out is kept.
      partialize: (state) => ({
        person: state.person,
        view: state.view,
        grouping: state.grouping,
        showDetail: state.showDetail,
        laneFolds: state.laneFolds,
      }),
    },
  ),
);

/** The name to write on what is done. Empty, the engine writes "person". */
export function usePersonName(): string {
  return useBoardStore((state) => state.person.trim());
}
