import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ReplyDraft {
  readonly text: string;
  readonly option: string | null;
  /** Persist before sending so leaving the thread cannot turn an unknown receipt into a replay. */
  readonly uncertain: boolean;
}
export const EMPTY_REPLY: ReplyDraft = { text: "", option: null, uncertain: false };
export const replyDraftKey = (environment: string, task: string, question: number) =>
  JSON.stringify([environment, task, question]);

interface ReplyDraftState {
  drafts: Record<string, ReplyDraft>;
  pending: Record<string, boolean>;
  update: (key: string, patch: Partial<ReplyDraft>) => void;
  begin: (key: string) => boolean;
  finish: (key: string, outcome: "accepted" | "rejected" | "unknown") => void;
  discard: (key: string) => void;
  /** Questions the person removed from the thread: "seen" once settled, "later" while waiting. */
  removed: Record<string, "seen" | "later">;
  remove: (key: string, how: "seen" | "later") => void;
}

/** A waiting question removed "later" comes back on the next load; a seen one stays gone. */
export const persistedReplyState = (state: Pick<ReplyDraftState, "drafts" | "removed">) => ({
  drafts: state.drafts,
  removed: Object.fromEntries(Object.entries(state.removed).filter(([, how]) => how === "seen")),
});

/** Only unsent input/receipt uncertainty is local. Q/A history always comes from the engine. */
export const useDeliveryReplyDrafts = create<ReplyDraftState>()(
  persist(
    (set, get) => ({
      drafts: {},
      pending: {},
      removed: {},
      remove: (key, how) => set((state) => ({ removed: { ...state.removed, [key]: how } })),
      update: (key, patch) =>
        set((state) => ({
          drafts: { ...state.drafts, [key]: { ...(state.drafts[key] ?? EMPTY_REPLY), ...patch } },
        })),
      begin: (key) => {
        const state = get();
        if (state.pending[key] || state.drafts[key]?.uncertain) return false;
        set({
          pending: { ...state.pending, [key]: true },
          drafts: {
            ...state.drafts,
            [key]: { ...(state.drafts[key] ?? EMPTY_REPLY), uncertain: true },
          },
        });
        return true;
      },
      finish: (key, outcome) =>
        set((state) => {
          const { [key]: _pending, ...pending } = state.pending;
          if (outcome === "accepted") {
            const { [key]: _draft, ...drafts } = state.drafts;
            return { pending, drafts };
          }
          return {
            pending,
            drafts: {
              ...state.drafts,
              [key]: { ...(state.drafts[key] ?? EMPTY_REPLY), uncertain: outcome === "unknown" },
            },
          };
        }),
      discard: (key) =>
        set((state) => {
          if (state.pending[key]) return state;
          const { [key]: _draft, ...drafts } = state.drafts;
          return { drafts };
        }),
    }),
    {
      name: "t3code:delivery-reply-drafts:v1",
      partialize: (state) => persistedReplyState(state),
    },
  ),
);
