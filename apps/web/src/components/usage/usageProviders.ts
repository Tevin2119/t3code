import type { UsageModelProviderSource, UsageProviderKind } from "@t3tools/contracts";

import {
  AntigravityIcon,
  ClaudeAI,
  DeepSeekIcon,
  GrokIcon,
  HermesIcon,
  type Icon,
  KimiIcon,
  OpenAI,
  OpenCodeIcon,
  PiAgentIcon,
} from "../Icons";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
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
    mark: OpenAI,
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    mark: ClaudeAI,
  },
  grok: {
    label: "Grok Build",
    // Contrast-aware neutral between the Codex series and muted chart chrome.
    color: "color-mix(in oklab, var(--contrast-foreground) 72%, var(--background))",
    mark: GrokIcon,
  },
  deepseek: {
    // Its tokens only: the DeepSeek harness records neither the model nor a price.
    label: "DeepSeek",
    color: "#4d6bfe",
    mark: DeepSeekIcon,
  },
  pi: {
    label: "pi",
    color: "#22a06b",
    mark: PiAgentIcon,
  },
  opencode: {
    label: "OpenCode",
    color: "#d9a53f",
    mark: OpenCodeIcon,
  },
  kimi: {
    label: "Kimi Code",
    color: "#2f9fd8",
    mark: KimiIcon,
  },
  hermes: {
    label: "Hermes",
    color: "#a26bd6",
    mark: HermesIcon,
  },
  antigravity: {
    label: "Antigravity",
    color: "#e0457b",
    mark: AntigravityIcon,
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
