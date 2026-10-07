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

const PROGRESS: Partial<Record<CheckoutUpdateState["phase"], string>> = {
  installing: "Installing the new version.",
  building: "Building the new version.",
  restarting: "Restarting. This page reconnects by itself.",
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
      title: "Updating T3",
      description: state.message ?? progress,
    };
  }
  if (state.phase === "failed") {
    const undone = state.lastOutcome?.status === "rolled-back";
    return {
      kind: "failed",
      key: `failed:${state.message ?? ""}`,
      title: undone ? "T3 update undone" : "T3 could not update",
      description: state.message ?? "The update did not finish. T3 is still on the version it was.",
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
