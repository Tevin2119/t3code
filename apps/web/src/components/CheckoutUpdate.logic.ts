import type { CheckoutUpdateState } from "@t3tools/contracts";

/** What a person is told about a server run from a git checkout. */
export type CheckoutUpdateView =
  | {
      readonly kind: "available";
      readonly key: string;
      readonly title: string;
      readonly description: string;
    }
  | {
      readonly kind: "progress";
      readonly key: string;
      readonly title: string;
      readonly description: string;
    }
  | {
      readonly kind: "failed";
      readonly key: string;
      readonly title: string;
      readonly description: string;
    }
  /** The server now runs another commit than the page was loaded from. */
  | {
      readonly kind: "reload";
      readonly key: string;
      readonly title: string;
      readonly description: string;
    };

export const shortCommit = (commit: string) => commit.slice(0, 7);

// The title names the phase; the description is the server's own words when it has some.
const PROGRESS: Partial<
  Record<CheckoutUpdateState["phase"], { readonly title: string; readonly description: string }>
> = {
  installing: { title: "Installing the T3 update", description: "Installing the new version." },
  building: { title: "Building the T3 update", description: "Building the new version." },
  restarting: {
    title: "Restarting T3",
    description: "Restarting. This page reconnects by itself.",
  },
};

export function availableUpdateLine(available: NonNullable<CheckoutUpdateState["available"]>) {
  const count =
    available.behind > 1
      ? `${available.behind} new commits`
      : available.behind === 1
        ? "1 new commit"
        : "";
  return [available.subject || shortCommit(available.commit), count].filter(Boolean).join(" · ");
}

/**
 * A failed phase was undone when the supervisor went back to the running
 * commit after the new one did not start. `lastOutcome` outlives its attempt,
 * so a later install or build failure, whose message is its own, is not one.
 */
function isUndone(state: CheckoutUpdateState): boolean {
  const outcome = state.lastOutcome;
  if (outcome?.status !== "rolled-back" || outcome.from !== state.running.commit) return false;
  return (
    state.message === null || outcome.reason === null || state.message.startsWith(outcome.reason)
  );
}

/**
 * The one thing to say, most pressing first: a page left on an older build,
 * an update under way, one that failed, then one on offer and not dismissed.
 */
export function checkoutUpdateView(
  state: CheckoutUpdateState | null,
  options: { readonly loadedCommit: string | null; readonly dismissedCommit: string | null },
): CheckoutUpdateView | null {
  if (state === null) return null;
  const running = state.running.commit;
  if (options.loadedCommit !== null && options.loadedCommit !== running) {
    return {
      kind: "reload",
      key: `reload:${running}`,
      title: "T3 was updated",
      description: `Now on ${shortCommit(running)}${state.running.subject ? `: ${state.running.subject}` : ""}. Reload to use it.`,
    };
  }
  const progress = PROGRESS[state.phase];
  if (progress !== undefined) {
    return {
      kind: "progress",
      key: `progress:${state.phase}`,
      title: progress.title,
      description: state.message ?? progress.description,
    };
  }
  if (state.phase === "failed") {
    const undone = isUndone(state);
    const description =
      state.message ??
      state.lastOutcome?.reason ??
      "The update did not finish. T3 is still on the version it was.";
    return {
      kind: "failed",
      key: `failed:${undone ? "undone" : "error"}:${running}:${description}`,
      title: undone ? "T3 update undone" : "T3 could not update",
      description,
    };
  }
  if (state.available !== null && state.available.commit !== options.dismissedCommit) {
    return {
      kind: "available",
      key: `available:${state.available.commit}`,
      title: "T3 update available",
      description: availableUpdateLine(state.available),
    };
  }
  return null;
}

/** Where the checkout update is shown: the v2 sidebar's pill, a toast, or nowhere. */
export type CheckoutUpdatePresentation = "none" | "toast" | "pill";

/**
 * The v2 sidebar footer holds the pill on every route but Settings, which swaps
 * the footer for its own nav. The legacy sidebar keeps the toast.
 */
export function checkoutUpdatePresentation(input: {
  readonly settingsHydrated: boolean;
  readonly supported: boolean;
  readonly legacySidebar: boolean;
  readonly pathname: string;
}): CheckoutUpdatePresentation {
  if (!input.settingsHydrated || !input.supported) return "none";
  if (input.legacySidebar) return "toast";
  if (input.pathname === "/settings" || input.pathname.startsWith("/settings/")) return "toast";
  return "pill";
}

/** The checkout update as the sidebar pill shows it. */
export interface CheckoutUpdatePillView {
  readonly key: string;
  readonly tone: "info" | "loading" | "error";
  readonly title: string;
  readonly description: string;
  /** Said under the description, such as a start request that did not go through. */
  readonly notice: string | null;
  readonly action: "update" | "starting" | "reload" | null;
  /** `dismiss` remembers the offered commit; `close` only hides this notice. */
  readonly close: "dismiss" | "close" | null;
}

export const CHECKOUT_UPDATE_NOT_STARTED = "The update did not start. Try again.";

export function checkoutUpdatePillView(
  view: CheckoutUpdateView | null,
  options: {
    readonly starting: boolean;
    readonly startFailed: boolean;
    /** A notice the person closed; hidden until the view's key changes. */
    readonly closedKey: string | null;
  },
): CheckoutUpdatePillView | null {
  if (view === null || view.key === options.closedKey) return null;
  const base = { key: view.key, title: view.title, description: view.description, notice: null };
  switch (view.kind) {
    case "available":
      return {
        ...base,
        tone: "info",
        notice: !options.starting && options.startFailed ? CHECKOUT_UPDATE_NOT_STARTED : null,
        action: options.starting ? "starting" : "update",
        close: options.starting ? null : "dismiss",
      };
    case "progress":
      return { ...base, tone: "loading", action: null, close: null };
    case "failed":
      return { ...base, tone: "error", action: null, close: "close" };
    case "reload":
      return { ...base, tone: "info", action: "reload", close: "close" };
  }
}
