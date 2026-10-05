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
    partialize: (state) => ({
      person: state.person,
      showDetail: state.showDetail,
      deliveryEnvironment: state.deliveryEnvironment,
      preferencesByEnvironment: Object.fromEntries(
        Object.entries(state.preferencesByEnvironment).map(([environment, preferences]) => [
          environment,
          { ...preferences, filters: NO_FILTERS },
        ]),
      ),
    }),
  }),
);
