/**
 * Coding plans a harness reaches a model through.
 *
 * A plan is billed as a flat subscription, so the harness records no cost and
 * names the plan, not the company, as the model's provider (OpenCode writes
 * `zai-coding-plan`, Kimi Code writes `kimi-code`). The model behind a plan is
 * the maker's own, so its API-equivalent cost is the maker's own rate, never a
 * reseller's.
 *
 * Keyed by the provider id the harness records; the value is the maker's prefix
 * in the LiteLLM rate table.
 */
const PLAN_MAKERS: Readonly<Record<string, string>> = {
  "zai-coding-plan": "zai",
  "kimi-code": "moonshot",
  "kimi-for-coding": "moonshot",
};

/** The maker whose rates price a model reached through this coding plan, or `null`. */
export function planMakerOf(modelProvider: string | null | undefined): string | null {
  if (!modelProvider) return null;
  return PLAN_MAKERS[modelProvider.trim().toLowerCase()] ?? null;
}

/**
 * Usage through a coding plan: its cost is what the same tokens would cost at
 * the maker's API rates, not money spent.
 */
export function isPlanModelProvider(modelProvider: string | null | undefined): boolean {
  return planMakerOf(modelProvider) !== null;
}

/** How a cost reached through a coding plan is labelled wherever it is shown. */
export const PLAN_COST_LABEL = "API-equivalent, on a plan";

/**
 * The note beside a cost of which `planUsd` came through a coding plan, or
 * `null` when none did. All of it reads as the label; part of it names the part.
 */
export function planCostNote(
  totalUsd: number,
  planUsd: number,
  formatUsd: (value: number) => string,
): string | null {
  if (!(planUsd > 0)) return null;
  // Summed in a different order, the two can differ by a rounding error.
  if (planUsd >= totalUsd - 1e-9) return PLAN_COST_LABEL;
  return `${formatUsd(planUsd)} ${PLAN_COST_LABEL}`;
}
