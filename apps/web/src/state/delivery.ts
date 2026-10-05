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
import { deliveryEnvironmentChoice } from "../lib/delivery";
import { boardSelectionPatch } from "../lib/deliveryBoardSelection";
import { boardPreferencesOf, useBoardStore } from "./deliveryBoard";
import { useEnvironments, usePrimaryEnvironmentId } from "./environments";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export type { SeatChoice };
export { useBoardStore } from "./deliveryBoard";

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
  /**
   * What of its seat each draft has taken over, as one key. What the seat runs
   * on is taken over once for each seat, so that what a person chooses after
   * that stands. Kept apart from the choices: a draft in the default team has
   * a seat too, and has made no choice.
   */
  readonly inherited: Record<string, string>;
  readonly setChoice: (threadId: string, choice: DraftTeamChoice) => void;
  readonly markInherited: (threadId: string, key: string) => void;
  readonly clearChoice: (threadId: string) => void;
}

const MAX_INHERITED_MARKS = 200;

/**
 * The mark of a thread that was sent. What it runs on is the person's from
 * then on: no seat is taken over any more, whatever the picker shows while
 * the thread is on its way.
 */
export const SEAT_TAKEOVER_OVER = "sent";

const withMark = (marks: Record<string, string>, threadId: string, key: string) => ({
  // The newest are kept. A thread that was sent long ago needs no mark.
  ...Object.fromEntries(
    Object.entries(marks)
      .filter(([id]) => id !== threadId)
      .slice(-(MAX_INHERITED_MARKS - 1)),
  ),
  [threadId]: key,
});

/** The team chosen for a thread that has not been sent yet. Kept across reloads. */
export const useDeliveryDraftStore = create<DeliveryDraftState>()(
  persist(
    (set) => ({
      choices: {},
      inherited: {},
      setChoice: (threadId, choice) =>
        set((state) => ({ choices: { ...state.choices, [threadId]: choice } })),
      markInherited: (threadId, key) =>
        set((state) =>
          state.inherited[threadId] === key || state.inherited[threadId] === SEAT_TAKEOVER_OVER
            ? state
            : { inherited: withMark(state.inherited, threadId, key) },
        ),
      clearChoice: (threadId) =>
        set((state) => {
          // The choice is cleared when the thread is sent, while the picker is still
          // shown. It then shows the default team, whose seat must not be taken over.
          const { [threadId]: _removed, ...rest } = state.choices;
          return {
            choices: rest,
            inherited: withMark(state.inherited, threadId, SEAT_TAKEOVER_OVER),
          };
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

export function useBoardPreferences(environment: string | null) {
  return useBoardStore((state) => boardPreferencesOf(state, environment));
}

export function useBoardControls(environment: string | null) {
  const update = useBoardStore((state) => state.updateBoard);
  return useMemo(
    () => ({
      setBoardSet: (boardSet: string) => update(environment, () => ({ boardSet })),
      setBoardSelection: (value: string) => {
        const patch = boardSelectionPatch(value);
        if (patch) update(environment, () => patch);
      },
      setView: (view: string) => update(environment, () => ({ view })),
      setFilters: (patch: Partial<BoardFilters>) =>
        update(environment, (current) => ({ filters: { ...current.filters, ...patch } })),
      clearFilters: () => update(environment, () => ({ filters: NO_FILTERS })),
      setGrouping: (grouping: BoardGrouping) => update(environment, () => ({ grouping })),
      foldLane: (lane: string, folded: boolean) =>
        update(environment, (current) => ({ laneFolds: { ...current.laneFolds, [lane]: folded } })),
      foldPanel: (group: string, folded: boolean) =>
        update(environment, (current) => ({
          panelFolds: { ...current.panelFolds, [group]: folded },
        })),
      setShared: (shared: boolean) => update(environment, () => ({ shared })),
      setSharedBoardSet: (sharedBoardSet: string) =>
        update(environment, () => ({ sharedBoardSet })),
    }),
    [environment, update],
  );
}

/** The name to write on what is done. Empty, the engine writes "person". */
export function usePersonName(): string {
  return useBoardStore((state) => state.person.trim());
}

/**
 * The environment whose delivery engine the Board, its panel and Profiles talk to. A window can be
 * connected to several environments, and the engine is the one of the environment the work lives
 * in, not always the window's own: a task made from a conversation goes to the engine of that
 * conversation's environment. Otherwise the one the person chose on the Board, if still connected;
 * otherwise the window's own. A URL can pin the environment. Turning delivery off does not change
 * whose tasks the screen shows.
 */
export function useDeliveryEnvironmentId(
  fromConversation: string | null = null,
  requested: string | null = null,
): EnvironmentId | null {
  const primary = usePrimaryEnvironmentId();
  const chosen = useBoardStore((state) => state.deliveryEnvironment);
  const { environments, isReady } = useEnvironments();
  const connected = environments.map((environment) => environment.environmentId);
  return deliveryEnvironmentChoice({
    fromConversation,
    chosen,
    requested,
    isReady,
    connected,
    primary,
  });
}
