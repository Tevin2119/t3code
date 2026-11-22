import {
  isProviderAvailable,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import { exhaustedUsageWindow } from "./usageLimits.ts";

/** A model as a seat runs it: on one provider instance. */
export interface SeatModel {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}

/** A model a thread or one of its seats failed on with a usage limit that has not reset yet. */
export interface SeatLimit extends SeatModel {
  readonly resetAt: string | null;
}

/** What T3 knows when it decides whether a seat is limited and what could stand in for it. */
export interface LimitedSeatFacts {
  readonly now: number;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<
    ServerSettings,
    "favorites" | "providerInstances" | "projectSettingsOverrides"
  >;
  readonly projectId: ProjectId | null;
  /** Limits read from turns that failed, which a provider's own status may not show. */
  readonly threadLimits: ReadonlyArray<SeatLimit>;
}

const MODEL_FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/claude|anthropic/i, "anthropic"],
  [/gpt|openai|codex|\bo\d\b/i, "openai"],
  [/gemini|google/i, "google"],
  [/grok|xai/i, "xai"],
  [/kimi|moonshot/i, "moonshot"],
  [/deepseek/i, "deepseek"],
  [/glm|zai|z\.ai|zhipu/i, "zhipu"],
];
const DRIVER_FAMILIES: Readonly<Record<string, string>> = {
  claudeAgent: "anthropic",
  codex: "openai",
  grok: "xai",
  kimi: "moonshot",
  deepseek: "deepseek",
};

/**
 * Whose usage a model draws on, as far as T3 can tell: the vendor its name shows, else the
 * harness's own. T3 holds no account identity across providers, so this errs toward "the same".
 */
export function modelAccountFamily(driver: string | undefined, model: string): string {
  const named = MODEL_FAMILIES.find(([pattern]) => pattern.test(model))?.[1];
  if (named) return named;
  const vendor = model.includes("/") ? model.split("/")[0]?.toLowerCase() : undefined;
  return vendor || (driver ? (DRIVER_FAMILIES[driver] ?? `driver:${driver}`) : "unknown");
}

const sameModel = (left: SeatModel, right: SeatModel) =>
  left.instanceId === right.instanceId && left.model === right.model;

/** Why a seat's model cannot run now, or null when no limit is known. */
export function seatLimit(facts: LimitedSeatFacts, seat: SeatModel): SeatLimit | null {
  const provider = facts.providers.find((entry) => entry.instanceId === seat.instanceId);
  const window = exhaustedUsageWindow(provider, facts.now, seat.model);
  if (window) return { ...seat, resetAt: window.resetsAt ?? null };
  return (
    facts.threadLimits.find(
      (limit) =>
        sameModel(limit, seat) && (limit.resetAt === null || Date.parse(limit.resetAt) > facts.now),
    ) ?? null
  );
}

export type LimitedSeatSkipReason =
  | "unavailable"
  | "limited"
  | "same-account"
  | "in-use"
  | "not-independent";

export interface LimitedSeatCandidate extends SeatModel {
  /** Null for a favorite that is free to stand in. */
  readonly skip: LimitedSeatSkipReason | null;
}

/**
 * The person's Favorites in their order, each free or skipped with its reason. Nothing outside
 * Favorites is ever offered. The first free one is the substitute.
 */
export function limitedSeatCandidates(input: {
  readonly facts: LimitedSeatFacts;
  /** The model that reached its limit. */
  readonly limited: SeatModel;
  /** What the other seats and the lead of the conversation run on. */
  readonly inUse: ReadonlyArray<SeatModel>;
  /** For a QA seat, what the builder seats run on; QA must not share a model with them. */
  readonly builderModels?: ReadonlyArray<SeatModel> | undefined;
}): ReadonlyArray<LimitedSeatCandidate> {
  const { facts, limited } = input;
  const providerOf = (instanceId: ProviderInstanceId) =>
    facts.providers.find((entry) => entry.instanceId === instanceId);
  const limitedProvider = providerOf(limited.instanceId);
  const limitedFamily = modelAccountFamily(limitedProvider?.driver, limited.model);
  const reason = (candidate: SeatModel): LimitedSeatSkipReason | null => {
    const provider = providerOf(candidate.instanceId);
    if (
      !provider ||
      !provider.enabled ||
      !provider.installed ||
      provider.status !== "ready" ||
      provider.auth.status === "unauthenticated" ||
      provider.supportsSessions === false ||
      !isProviderAvailable(provider) ||
      !resolveProjectProviderInstanceEnabled(facts.settings, facts.projectId, candidate.instanceId)
    )
      return "unavailable";
    if (seatLimit(facts, candidate)) return "limited";
    const sameAccount =
      candidate.instanceId === limited.instanceId ||
      (provider.driver === limitedProvider?.driver &&
        provider.auth.email !== undefined &&
        provider.auth.email === limitedProvider.auth.email) ||
      modelAccountFamily(provider.driver, candidate.model) === limitedFamily;
    if (sameAccount) return "same-account";
    if (input.inUse.some((used) => sameModel(used, candidate))) return "in-use";
    // The same model on another account is still the builder's model.
    if (input.builderModels?.some((builder) => builder.model === candidate.model))
      return "not-independent";
    return null;
  };
  return (facts.settings.favorites ?? []).map((favorite) => {
    const candidate = { instanceId: favorite.provider, model: favorite.model };
    return { ...candidate, skip: reason(candidate) };
  });
}

/** The first free favorite, or null when none is free. */
export const firstFreeFavorite = (
  candidates: ReadonlyArray<LimitedSeatCandidate>,
): SeatModel | null => {
  const free = candidates.find((candidate) => candidate.skip === null);
  return free ? { instanceId: free.instanceId, model: free.model } : null;
};

export const seatModelOf = (selection: ModelSelection): SeatModel => ({
  instanceId: selection.instanceId,
  model: selection.model,
});

/** A seat of a conversation, as the limited-seat rule reads it. */
export interface LimitedSeatRosterSeat {
  readonly seat: string;
  readonly modelSelection: ModelSelection;
  readonly duty?: "build" | "qa" | undefined;
}

/** The pool for one seat of a conversation: every other seat's model and the lead's are in use. */
export function limitedSeatPool<Seat extends LimitedSeatRosterSeat>(input: {
  readonly facts: LimitedSeatFacts;
  readonly roster: ReadonlyArray<Seat>;
  readonly lead: ModelSelection;
  readonly seat: Seat;
  /** What a seat runs on this turn, when a substitute already stands in for it. */
  readonly runsOn?: (seat: Seat) => ModelSelection;
}): ReadonlyArray<LimitedSeatCandidate> {
  const runsOn = input.runsOn ?? ((seat: Seat) => seat.modelSelection);
  return limitedSeatCandidates({
    facts: input.facts,
    limited: seatModelOf(input.seat.modelSelection),
    inUse: [
      seatModelOf(input.lead),
      ...input.roster
        .filter((other) => other.seat !== input.seat.seat)
        .map((other) => seatModelOf(runsOn(other))),
    ],
    builderModels:
      input.seat.duty === "qa"
        ? input.roster
            .flatMap((other) =>
              other.duty === "build" ? [other.modelSelection, runsOn(other)] : [],
            )
            .map(seatModelOf)
        : undefined,
  });
}

/** The pool for the lead of a conversation: every seat's model is in use. */
export const limitedLeadPool = (input: {
  readonly facts: LimitedSeatFacts;
  readonly roster: ReadonlyArray<LimitedSeatRosterSeat>;
  readonly lead: ModelSelection;
}): ReadonlyArray<LimitedSeatCandidate> =>
  limitedSeatCandidates({
    facts: input.facts,
    limited: seatModelOf(input.lead),
    inUse: input.roster.map((seat) => seatModelOf(seat.modelSelection)),
  });

/** Whether a model is among the free candidates of a pool. */
export const isFreeCandidate = (
  pool: ReadonlyArray<LimitedSeatCandidate>,
  model: SeatModel,
): boolean =>
  pool.some(
    (candidate) =>
      candidate.skip === null &&
      candidate.instanceId === model.instanceId &&
      candidate.model === model.model,
  );
