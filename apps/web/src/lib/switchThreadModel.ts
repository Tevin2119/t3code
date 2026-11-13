import type { ProviderInstanceId, RunId } from "@t3tools/contracts";

const FORKABLE_RUN_STATUSES = new Set([
  "completed",
  "waiting",
  "failed",
  "interrupted",
  "cancelled",
]);

export interface ForkableRun {
  readonly id: RunId;
  readonly status: string;
}

/** The newest run a fork can start from, or null while nothing finished yet. */
export function latestForkableRun(
  runs: ReadonlyArray<ForkableRun> | undefined,
): ForkableRun | null {
  if (!runs) return null;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (FORKABLE_RUN_STATUSES.has(run.status)) return run;
  }
  return null;
}

/**
 * Whether a provider/model pick can stay in this thread. Same instance and
 * unbound threads whose provider hands context over switch in place, keeping
 * the conversation; only what cannot switch in place has nowhere to go.
 */
export function canSwitchModelInPlace(input: {
  readonly deliveryBinding: { readonly driver: string } | null;
  readonly supportsProviderSwitchingViaHandoff: boolean;
  readonly hasStartedSession: boolean;
  readonly currentProviderInstanceId: ProviderInstanceId | null;
  readonly nextInstanceId: ProviderInstanceId;
}): boolean {
  if (!input.hasStartedSession) return true;
  if (
    input.currentProviderInstanceId !== null &&
    input.currentProviderInstanceId === input.nextInstanceId
  ) {
    return true;
  }
  return !input.deliveryBinding && input.supportsProviderSwitchingViaHandoff;
}

/**
 * Where a pick continues when it cannot switch in place: a native fork of the
 * newest finished run, which copies the conversation over. Null means the
 * picker's own refusal is the only answer (nothing to fork yet).
 */
export function planModelSwitchFork(input: {
  readonly deliveryBinding: { readonly driver: string } | null;
  readonly supportsProviderSwitchingViaHandoff: boolean;
  readonly hasStartedSession: boolean;
  readonly currentProviderInstanceId: ProviderInstanceId | null;
  readonly nextInstanceId: ProviderInstanceId;
  readonly runs: ReadonlyArray<ForkableRun> | undefined;
}): RunId | null {
  if (canSwitchModelInPlace(input)) return null;
  return latestForkableRun(input.runs)?.id ?? null;
}
