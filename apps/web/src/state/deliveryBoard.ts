import { create, type StateCreator } from "zustand";
import { persist } from "zustand/middleware";

import { NO_FILTERS, type BoardFilters, type BoardGrouping } from "../lib/deliveryBoard";

export interface BoardPreferences {
  readonly boardSet: string;
  readonly view: string;
  readonly filters: BoardFilters;
  readonly grouping: BoardGrouping;
  readonly laneFolds: Readonly<Record<string, boolean>>;
  readonly panelFolds: Readonly<Record<string, boolean>>;
  readonly shared: boolean;
  readonly sharedBoardSet: string;
}

const DEFAULT_BOARD_PREFERENCES: BoardPreferences = {
  boardSet: "unsorted",
  view: "development",
  filters: NO_FILTERS,
  grouping: "none",
  laneFolds: {},
  panelFolds: {},
  shared: false,
  sharedBoardSet: "",
};

export interface BoardState {
  readonly person: string;
  readonly showDetail: boolean;
  readonly deliveryEnvironment: string | null;
  readonly preferencesByEnvironment: Readonly<Record<string, BoardPreferences>>;
  readonly setDeliveryEnvironment: (environment: string | null) => void;
  readonly setPerson: (person: string) => void;
  readonly setShowDetail: (showDetail: boolean) => void;
  readonly updateBoard: (
    environment: string | null,
    change: (current: BoardPreferences) => Partial<BoardPreferences>,
  ) => void;
}

export const boardPreferencesOf = (
  state: Pick<BoardState, "preferencesByEnvironment">,
  environment: string | null,
): BoardPreferences =>
  state.preferencesByEnvironment[environment ?? ""] ?? DEFAULT_BOARD_PREFERENCES;

export const createBoardState: StateCreator<BoardState> = (set) => ({
  person: "",
  showDetail: false,
  deliveryEnvironment: null,
  preferencesByEnvironment: {},
  setDeliveryEnvironment: (deliveryEnvironment) => set({ deliveryEnvironment }),
  setPerson: (person) => set({ person: person.slice(0, 60) }),
  setShowDetail: (showDetail) => set({ showDetail }),
  updateBoard: (environment, change) =>
    set((state) => {
      const current = boardPreferencesOf(state, environment);
      return {
        preferencesByEnvironment: {
          ...state.preferencesByEnvironment,
          [environment ?? ""]: { ...current, ...change(current) },
        },
      };
    }),
});

/**
 * The tags that were chosen, from what was kept on this device. Before several could be chosen
 * one was kept as `tag`; it is read only when no list was kept. Anything else is no tag.
 */
export function keptTags(filters: unknown): ReadonlyArray<string> {
  if (typeof filters !== "object" || filters === null) return [];
  const { tags, tag } = filters as { readonly tags?: unknown; readonly tag?: unknown };
  const list = tags === undefined ? [tag] : Array.isArray(tags) ? tags : [];
  return [
    ...new Set(list.filter((item): item is string => typeof item === "string" && item !== "")),
  ];
}

/** What was kept of an environment's filters: its tags, over filters that are otherwise off. */
const keptFilters = (filters: unknown): BoardFilters => ({
  ...NO_FILTERS,
  tags: keptTags(filters),
});

export function migrateBoardState(value: unknown) {
  const kept = (value ?? {}) as Partial<BoardState & BoardPreferences>;
  const preferencesByEnvironment = kept.deliveryEnvironment
    ? {
        [kept.deliveryEnvironment]: {
          ...DEFAULT_BOARD_PREFERENCES,
          boardSet: kept.boardSet ?? "unsorted",
          view: kept.view ?? "development",
          grouping: kept.grouping ?? "none",
          laneFolds: kept.laneFolds ?? {},
          panelFolds: kept.panelFolds ?? {},
          filters: keptFilters(kept.filters),
        },
      }
    : {};
  return {
    person: kept.person ?? "",
    showDetail: kept.showDetail ?? false,
    deliveryEnvironment: kept.deliveryEnvironment ?? null,
    preferencesByEnvironment,
  };
}

export const useBoardStore = create<BoardState>()(
  persist(createBoardState, {
    name: "t3code:delivery-board:v1",
    version: 2,
    migrate: migrateBoardState,
    // Runs for what was kept at this version too, which migrate does not see.
    merge: (kept, current) => {
      const { preferencesByEnvironment, ...rest } = (kept ?? {}) as Partial<BoardState>;
      return {
        ...current,
        ...rest,
        preferencesByEnvironment: Object.fromEntries(
          Object.entries(preferencesByEnvironment ?? {}).map(([environment, preferences]) => [
            environment,
            { ...preferences, filters: keptFilters(preferences?.filters) },
          ]),
        ),
      };
    },
    // A search is for now, and so is every filter but the tags. How the board is laid out is kept.
    partialize: (state) => ({
      person: state.person,
      showDetail: state.showDetail,
      deliveryEnvironment: state.deliveryEnvironment,
      preferencesByEnvironment: Object.fromEntries(
        Object.entries(state.preferencesByEnvironment).map(([environment, preferences]) => [
          environment,
          { ...preferences, filters: { tags: preferences.filters.tags } },
        ]),
      ),
    }),
  }),
);
