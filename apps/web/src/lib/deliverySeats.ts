/**
 * Seats and the catalog of harnesses and models. A seat is chosen for the
 * way a thread's model is: the harness first, then a model that harness
 * has. The engine names harnesses its own way, so the two are mapped here.
 */
import { DELIVERY_HARNESS_BY_DRIVER } from "@t3tools/contracts";

import type { SeatChoice, SeatSettings, SeatSettingValues } from "./delivery";

const DRIVER_BY_HARNESS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(DELIVERY_HARNESS_BY_DRIVER).map(([driver, harness]) => [harness, driver]),
);

export const harnessOfDriver = (driver: string): string | null =>
  DELIVERY_HARNESS_BY_DRIVER[driver] ?? null;
export const driverOfHarness = (harness: string): string | null =>
  DRIVER_BY_HARNESS[harness] ?? null;

export const HARNESS_LABEL: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  kimi: "Kimi",
  dsh: "DeepSeek",
  hermes: "Hermes",
};

export const harnessLabel = (harness: string | null): string =>
  harness ? (HARNESS_LABEL[harness] ?? harness) : "No harness";

interface CatalogEntry {
  readonly instanceId: string;
  readonly driverKind: string;
  readonly isDefault: boolean;
}

/** The entries a seat may be moved between: the harnesses the engine knows, and may use here. */
export function entriesForSeat<Entry extends CatalogEntry>(
  entries: ReadonlyArray<Entry>,
  item: SeatSettings,
): ReadonlyArray<Entry> {
  const current = item.now.harness ?? item.harness;
  const allowed = new Set(item.may.harness.length > 0 ? item.may.harness : [current]);
  return entries.filter((entry) => {
    const harness = harnessOfDriver(entry.driverKind);
    return harness !== null && allowed.has(harness);
  });
}

/** The entry a harness is shown as. A harness set up more than once is shown as its first. */
export function entryForHarness<Entry extends CatalogEntry>(
  entries: ReadonlyArray<Entry>,
  harness: string | null,
): Entry | null {
  if (!harness) return null;
  const driver = driverOfHarness(harness);
  const mine = entries.filter((entry) => entry.driverKind === driver);
  return mine.find((entry) => entry.isDefault) ?? mine[0] ?? null;
}

interface ModelOption {
  readonly slug: string;
  readonly name: string;
}

/**
 * The models offered for a harness, with the ones the team names for the
 * seat first. A model the team names and the catalog does not list is kept,
 * under its own name: the team's definition is what runs.
 */
export function withTeamModels<Option extends ModelOption>(
  options: ReadonlyArray<Option>,
  named: ReadonlyArray<string>,
  make: (slug: string) => Option,
): ReadonlyArray<Option> {
  if (named.length === 0) return options;
  const first = named.map((slug) => options.find((option) => option.slug === slug) ?? make(slug));
  return [...first, ...options.filter((option) => !named.includes(option.slug))];
}

/** What a seat would run on with this choice laid over a base. */
export function seatValues(base: SeatSettingValues, choice: SeatChoice): SeatSettingValues {
  const moved = choice.harness !== undefined && choice.harness !== base.harness;
  return {
    active: choice.active ?? base.active ?? "on",
    harness: choice.harness ?? base.harness,
    // What was set for the harness it left means nothing to the one it moved to.
    model: choice.model ?? (moved ? null : base.model),
    reasoning: choice.reasoning ?? (moved ? null : base.reasoning),
    access: choice.access ?? (moved ? null : base.access),
  };
}

/** One line for a seat: what it runs on. */
export function describeSeatValues(values: SeatSettingValues): string {
  const parts = [
    harnessLabel(values.harness),
    values.model ?? "its own model",
    values.reasoning ? `${values.reasoning} reasoning` : null,
    values.access && values.access !== "full" ? `${values.access} access` : null,
  ];
  return parts.filter(Boolean).join(", ");
}

/**
 * The shares of the builds as parts of a hundred, for showing. Shares are
 * weights: 3 and 1 come to 75 and 25.
 */
export function sharePercentages(
  shares: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const total = Object.values(shares).reduce((sum, share) => sum + Math.max(0, share), 0);
  return Object.fromEntries(
    Object.entries(shares).map(([seat, share]) => [
      seat,
      total > 0 ? Math.round((Math.max(0, share) / total) * 100) : 0,
    ]),
  );
}

/** What the engine has on record of what a team thread ran on. */
export interface SessionEffective {
  readonly at: string;
  readonly reason: string | null;
  readonly requested: Readonly<Record<string, string | null>>;
  readonly passed: Readonly<Record<string, string | null>>;
  readonly confirmed: Readonly<Record<string, string | null>>;
  readonly confirmedBy: Readonly<Record<string, string | null>>;
  readonly overrides: ReadonlyArray<{
    readonly setting: string;
    readonly seat: string | null;
    readonly chosen: string | null;
  }>;
  readonly disagrees: ReadonlyArray<{
    readonly setting: string;
    readonly passed: string | null;
    readonly confirmed: string | null;
  }>;
  readonly notConfirmed: ReadonlyArray<string>;
  readonly notApplied: ReadonlyArray<{ readonly setting: string; readonly why: string }>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const asText = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const asValues = (value: unknown): Record<string, string | null> =>
  Object.fromEntries(Object.entries(asRecord(value)).map(([key, item]) => [key, asText(item)]));
const asRows = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value) ? value.map(asRecord) : [];

/** Reads the last report of a session from the engine's view of it, or null when there is none. */
export function parseSessionEffective(body: unknown): SessionEffective | null {
  const effective = asRecord(asRecord(body).effective);
  const at = asText(effective.at);
  if (!at) return null;
  return {
    at,
    reason: asText(effective.reason),
    requested: asValues(effective.requested),
    passed: asValues(effective.passed),
    confirmed: asValues(effective.confirmed),
    confirmedBy: asValues(effective.confirmedBy),
    overrides: asRows(effective.overrides).map((row) => ({
      setting: asText(row.setting) ?? "",
      seat: asText(row.seat),
      chosen: asText(row.chosen),
    })),
    disagrees: asRows(effective.disagrees).map((row) => ({
      setting: asText(row.setting) ?? "",
      passed: asText(row.passed),
      confirmed: asText(row.confirmed),
    })),
    notConfirmed: Array.isArray(effective.notConfirmed)
      ? effective.notConfirmed.filter((item): item is string => typeof item === "string")
      : [],
    notApplied: asRows(effective.notApplied).map((row) => ({
      setting: asText(row.setting) ?? "",
      why: asText(row.why) ?? "",
    })),
  };
}

/** One line for each setting: what was chosen, what was passed, what the harness confirmed. */
export function describeEffective(
  effective: SessionEffective,
): ReadonlyArray<readonly [string, string]> {
  return (["model", "reasoning", "runtimeMode"] as const).map((key) => {
    const name = key === "runtimeMode" ? "Access mode" : key === "model" ? "Model" : "Reasoning";
    const chosen = effective.requested[key] ?? "left to the harness";
    const confirmed = effective.confirmed[key];
    const passed = effective.passed[key];
    const standing = confirmed
      ? confirmed === chosen
        ? `confirmed by ${effective.confirmedBy[key] ?? "the harness"}`
        : `the harness reports ${confirmed} (${effective.confirmedBy[key] ?? "the harness"})`
      : passed
        ? "passed to the harness, not confirmed by it"
        : "chosen, with no report from the harness";
    return [name, `${chosen}: ${standing}`] as const;
  });
}

/** The option of each driver that sets how hard the model reasons. */
export const REASONING_OPTION_BY_DRIVER: Readonly<Record<string, string>> = {
  claudeAgent: "effort",
  codex: "reasoningEffort",
  opencode: "variant",
  pi: "thinking",
  kimi: "thinking",
  deepseek: "reasoning_effort",
};

/** What a thread takes over from the seat it is bound to. */
export interface SeatForThread {
  /** Null for a role taken by choice, which no seat on this harness holds. */
  readonly seat: string | null;
  readonly harness: string;
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly access: string | null;
}

/**
 * The seat a thread on this harness gets in this role, as the team has it now:
 * the team's definition with the saved defaults laid over it. A role no seat on
 * the harness holds takes the model of a seat that runs on the harness, as the
 * engine does when it opens the session.
 */
export function seatForThread(
  settings: ReadonlyArray<SeatSettings>,
  harness: string,
  role: string,
): SeatForThread {
  const onHarness = settings.filter((item) => (item.now.harness ?? item.harness) === harness);
  const held = onHarness.find((item) => item.role === role);
  if (held) {
    return {
      seat: held.seat,
      harness,
      model: held.now.model,
      reasoning: held.now.reasoning,
      access: held.now.access,
    };
  }
  return {
    seat: null,
    harness,
    model: onHarness[0]?.now.model ?? null,
    reasoning: null,
    access: "full",
  };
}

/** One key for what was taken over, so that it is taken over once and not again. */
export const seatKey = (team: string, role: string, seat: SeatForThread): string =>
  [team, role, seat.harness, seat.model ?? "", seat.reasoning ?? "", seat.access ?? ""].join("|");

export interface SeatOverride {
  readonly setting: "model" | "reasoning" | "access";
  readonly seat: string;
  readonly chosen: string;
}

/**
 * Where what is chosen for a thread is not what its seat has. Only what the
 * seat names can be overridden: a seat that leaves its model or its level to
 * the harness is matched by any choice. Of the access modes only full access
 * has a counterpart in a seat, so it is the one held against a seat's access.
 */
export function seatOverrides(
  seat: SeatForThread,
  chosen: {
    readonly model: string | null;
    readonly reasoning: string | null;
    readonly runtimeMode: string | null;
  },
): ReadonlyArray<SeatOverride> {
  const found: Array<SeatOverride> = [];
  if (seat.model && chosen.model && seat.model !== chosen.model) {
    found.push({ setting: "model", seat: seat.model, chosen: chosen.model });
  }
  if (seat.reasoning && (chosen.reasoning ?? "harness default") !== seat.reasoning) {
    found.push({
      setting: "reasoning",
      seat: seat.reasoning,
      chosen: chosen.reasoning ?? "harness default",
    });
  }
  const seatIsFull = (seat.access ?? "full") === "full";
  const chosenIsFull = chosen.runtimeMode === "full-access";
  if (chosen.runtimeMode && seatIsFull !== chosenIsFull) {
    found.push({
      setting: "access",
      seat: `${seat.access ?? "full"} access`,
      chosen: chosen.runtimeMode,
    });
  }
  return found;
}
