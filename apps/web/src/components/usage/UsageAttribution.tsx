import type { UsageProviderKind, UsageSource } from "@t3tools/contracts";
import { formatCount, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import type { MergedUsage, ModelProviderTotals, UsageFilter } from "@t3tools/shared/usageMerge";
import { ChevronDownIcon, XIcon } from "lucide-react";

import type { EnvironmentUsageStatus } from "../../state/usage";
import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { modelProviderLabel, PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

export interface UsageFilterState {
  readonly harnesses: ReadonlySet<UsageProviderKind>;
  /** `""` stands for usage whose provider was not recorded. */
  readonly modelProviders: ReadonlySet<string>;
  readonly models: ReadonlySet<string>;
}

export const NO_USAGE_FILTER: UsageFilterState = {
  harnesses: new Set(),
  modelProviders: new Set(),
  models: new Set(),
};

export const hasUsageFilter = (filter: UsageFilterState): boolean =>
  filter.harnesses.size > 0 || filter.modelProviders.size > 0 || filter.models.size > 0;

export const toUsageFilter = (filter: UsageFilterState): UsageFilter => filter;

const toggled = <T,>(set: ReadonlySet<T>, value: T, on: boolean): ReadonlySet<T> => {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
};

function FilterMenu(props: {
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly chosen: ReadonlySet<string>;
  readonly onChange: (value: string, on: boolean) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="xs" variant={props.chosen.size > 0 ? "outline" : "ghost"}>
            {props.label}
            {props.chosen.size > 0 ? ` (${props.chosen.size})` : ""}
            <ChevronDownIcon className="size-3" aria-hidden />
          </Button>
        }
      />
      <MenuPopup align="start" className="max-h-80 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto">
        {props.options.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">Nothing in this window.</p>
        ) : null}
        {props.options.map((option) => (
          <MenuCheckboxItem
            key={option.value}
            checked={props.chosen.has(option.value)}
            closeOnClick={false}
            onCheckedChange={(on) => props.onChange(option.value, on)}
          >
            <span className="truncate">{option.label}</span>
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/**
 * Narrows the page by the harness that made the calls, the company whose model
 * answered, and the model. The options are what the window holds, unnarrowed.
 */
export function UsageFilterBar(props: {
  readonly all: MergedUsage;
  readonly filter: UsageFilterState;
  readonly onChange: (filter: UsageFilterState) => void;
}) {
  const { all, filter, onChange } = props;
  const harnesses = PROVIDER_ORDER.filter((kind) =>
    all.providers.some((entry) => entry.provider === kind && entry.records > 0),
  ).map((kind) => ({ value: kind, label: PROVIDER_PRESENTATION[kind].label }));
  const providers = all.modelProviders.map((entry) => ({
    value: entry.modelProvider ?? "",
    label: modelProviderLabel(entry.modelProvider, entry.modelProviderSource),
  }));
  const models = [...new Set(all.models.map((entry) => entry.model))]
    .toSorted((a, b) => a.localeCompare(b))
    .map((model) => {
      const through = all.models.filter((entry) => entry.model === model).length;
      return { value: model, label: through > 1 ? `${model} (${through} harnesses)` : model };
    });
  const chips = [
    ...[...filter.harnesses].map((value) => ({
      key: `h:${value}`,
      label: `Harness: ${PROVIDER_PRESENTATION[value].label}`,
      clear: () => onChange({ ...filter, harnesses: toggled(filter.harnesses, value, false) }),
    })),
    ...[...filter.modelProviders].map((value) => ({
      key: `p:${value}`,
      label: `Provider: ${value === "" ? "not recorded" : value}`,
      clear: () =>
        onChange({ ...filter, modelProviders: toggled(filter.modelProviders, value, false) }),
    })),
    ...[...filter.models].map((value) => ({
      key: `m:${value}`,
      label: `Model: ${value}`,
      clear: () => onChange({ ...filter, models: toggled(filter.models, value, false) }),
    })),
  ];
  return (
    <div className="flex flex-col gap-2" data-usage-filters>
      <div className="flex flex-wrap items-center gap-1">
        <FilterMenu
          label="Harness"
          options={harnesses}
          chosen={filter.harnesses}
          onChange={(value, on) =>
            onChange({
              ...filter,
              harnesses: toggled(filter.harnesses, value as UsageProviderKind, on),
            })
          }
        />
        <FilterMenu
          label="Provider"
          options={providers}
          chosen={filter.modelProviders}
          onChange={(value, on) =>
            onChange({ ...filter, modelProviders: toggled(filter.modelProviders, value, on) })
          }
        />
        <FilterMenu
          label="Model"
          options={models}
          chosen={filter.models}
          onChange={(value, on) =>
            onChange({ ...filter, models: toggled(filter.models, value, on) })
          }
        />
      </div>
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1" data-usage-filter-chips>
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs"
            >
              <span className="truncate">{chip.label}</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${chip.label}`}
                onClick={chip.clear}
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
          <Button size="xs" variant="ghost" onClick={() => onChange(NO_USAGE_FILTER)}>
            Reset filters
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Usage by the company whose models answered, across the harnesses that called them. */
export function ProviderBreakdownTable(props: {
  readonly rows: ReadonlyArray<ModelProviderTotals>;
  readonly onChoose: (modelProvider: string | null) => void;
}) {
  return (
    <table className="w-full table-fixed text-sm" data-usage-provider-table>
      <colgroup>
        <col className="w-2/5" />
        <col className="w-1/5" />
        <col className="w-1/5" />
        <col className="w-1/5" />
      </colgroup>
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="py-2 font-normal">Provider</th>
          <th className="py-2 font-normal">Through</th>
          <th className="py-2 text-right font-normal">Cost</th>
          <th className="py-2 text-right font-normal">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.length === 0 ? (
          <tr>
            <td colSpan={4} className="py-6 text-center text-muted-foreground">
              No activity in this window.
            </td>
          </tr>
        ) : (
          props.rows.map((row) => (
            <tr
              key={row.modelProvider ?? ""}
              className="cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/50"
              onClick={() => props.onChoose(row.modelProvider)}
            >
              <td className="py-2 text-foreground">
                <span className={row.modelProvider === null ? "text-muted-foreground" : ""}>
                  {modelProviderLabel(row.modelProvider, row.modelProviderSource)}
                </span>
              </td>
              <td className="py-2 text-xs text-muted-foreground">
                {row.harnesses.map((kind) => PROVIDER_PRESENTATION[kind].label).join(", ")}
              </td>
              <td className="py-2 text-right tabular-nums">
                {row.records > 0 && row.unpricedRecords >= row.records ? (
                  <span className="text-muted-foreground">Unpriced</span>
                ) : (
                  formatUsd(row.costUsd)
                )}
              </td>
              <td className="py-2 text-right text-muted-foreground tabular-nums">
                {formatTokens(row.totalTokens)}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

const SOURCE_STATUS: Record<UsageSource["status"], string> = {
  ok: "read",
  missing: "none on this environment",
  partial: "read in part",
  failed: "could not be read",
};

/**
 * What the figures on this page are, and where each harness's come from. Kept
 * apart from the figures so the page stays short, and open to anyone who asks.
 */
export function UsageCountedNote(props: {
  readonly environments: ReadonlyArray<EnvironmentUsageStatus>;
}) {
  const sources = props.environments.flatMap((environment) =>
    (environment.summary?.sources ?? []).map((source) => ({
      environment: environment.label,
      source,
    })),
  );
  return (
    <details className="rounded-md border border-border px-3 py-2 text-xs" data-usage-counted>
      <summary className="cursor-pointer text-sm font-medium text-foreground">
        What is counted here
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-muted-foreground">
        <p>
          Tokens are the harnesses' own record of each call to a model, read from where each harness
          keeps it. A turn of a T3 thread or of a delivery engine run is in that record already, so
          it is counted once, from there; neither is added again. pi keeps the sessions of engine
          runs in the engine's folder, which is read as a source of its own.
        </p>
        <p>
          Harness is the program that made the calls. Provider is the company whose model answered,
          as the harness recorded it. The same model through two harnesses is two rows. Where a
          harness records no provider or no model, it says so here rather than guessing: DeepSeek
          records neither, only the totals of each session, and Hermes and DeepSeek date a session's
          usage by its last use.
        </p>
        <p>
          Cost is what the tokens would cost at API rates: the harness's own figure where it writes
          one (pi, OpenCode, Hermes when it knows it), else the public rate table. Unpriced means no
          figure is known, not free. It is not what a subscription charges. Context occupancy (how
          full a thread's window is) is shown in the thread, and subscription limits under Limits;
          neither is a count of tokens used.
        </p>
        {sources.length > 0 ? (
          <ul className="flex flex-col gap-0.5" data-usage-sources>
            {sources.map(({ environment, source }) => (
              <li
                key={`${environment}:${source.fingerprint.provider}:${source.fingerprint.resolvedHomePath}`}
                className="break-all"
              >
                <span className="text-foreground">
                  {PROVIDER_PRESENTATION[source.fingerprint.provider].label}
                </span>{" "}
                {SOURCE_STATUS[source.status]}: {source.fingerprint.resolvedHomePath}
                {source.status === "ok"
                  ? ` (${formatCount(source.scannedFiles)} files, ${formatCount(source.distinctSessions)} sessions)`
                  : ""}
                {source.message ? `. ${source.message}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}
