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
