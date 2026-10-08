import type { UsageModelProviderSource, UsageProviderKind } from "@t3tools/contracts";

import { ProviderDriverKind } from "@t3tools/contracts";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly driverKind: ProviderDriverKind;
};

/**
 * Exhaustive presentation for providers supported by the usage contract.
 * Declaration order is reused by every chart and table, so adding a provider
 * only requires its contract support and one entry here.
 */
export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--contrast-foreground)",
    driverKind: ProviderDriverKind.make("codex"),
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    driverKind: ProviderDriverKind.make("claudeAgent"),
  },
  grok: {
    label: "Grok Build",
    // Contrast-aware neutral between the Codex series and muted chart chrome.
    color: "color-mix(in oklab, var(--contrast-foreground) 72%, var(--background))",
    driverKind: ProviderDriverKind.make("grok"),
  },
  cursor: { label: "Cursor", color: "#8b8b8b", driverKind: ProviderDriverKind.make("cursor") },
  opencode: {
    label: "OpenCode",
    color: "#5b9bbd",
    driverKind: ProviderDriverKind.make("opencode"),
  },
  antigravity: {
    label: "Antigravity",
    color: "#8c7bd1",
    driverKind: ProviderDriverKind.make("antigravity"),
  },
  deepseek: {
    // Its tokens only: the DeepSeek harness records neither the model nor a price.
    label: "DeepSeek",
    color: "#4d6bfe",
    driverKind: ProviderDriverKind.make("deepseek"),
  },
  pi: {
    label: "pi",
    color: "#22a06b",
    driverKind: ProviderDriverKind.make("pi"),
  },
  kimi: {
    label: "Kimi Code",
    color: "#2f9fd8",
    driverKind: ProviderDriverKind.make("kimi"),
  },
  hermes: {
    label: "Hermes",
    color: "#a26bd6",
    driverKind: ProviderDriverKind.make("hermes"),
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

/**
 * The company whose model answered, as a person reads it. A provider known only
 * because its harness calls no other is said to be so, and none recorded is
 * said plainly rather than guessed.
 */
export function modelProviderLabel(
  modelProvider: string | null,
  source: UsageModelProviderSource | null,
): string {
  if (modelProvider === null) return "provider not recorded";
  return source === "harness" ? `${modelProvider} (the harness's only provider)` : modelProvider;
}

/** Stable provider reading order across charts, summaries, tables, and hover rows. */
export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];

/** Providers with real activity, independent of the metric currently displayed. */
export function providersWithUsage(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const active = new Set(
    totals
      .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
      .map((entry) => entry.provider),
  );
  return PROVIDER_ORDER.filter((provider) => active.has(provider));
}
