import type {
  EnvironmentId,
  UsageAccount,
  UsageProviderKind,
  UsageSource,
} from "@t3tools/contracts";
import { formatCount, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import type { AccountTotals, MergedUsage, UsageFilter } from "@t3tools/shared/usageMerge";
import { ChevronDownIcon, UsersIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { modelProviderLabel, PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

export interface UsageFilterState {
  readonly harnesses: ReadonlySet<UsageProviderKind>;
  /** `""` stands for usage whose provider was not recorded. */
  readonly modelProviders: ReadonlySet<string>;
  readonly models: ReadonlySet<string>;
  /** Accounts the user grouped connections under. */
  readonly accounts: ReadonlySet<string>;
}

export const NO_USAGE_FILTER: UsageFilterState = {
  harnesses: new Set(),
  modelProviders: new Set(),
  models: new Set(),
  accounts: new Set(),
};

export const hasUsageFilter = (filter: UsageFilterState): boolean =>
  filter.harnesses.size > 0 ||
  filter.modelProviders.size > 0 ||
  filter.models.size > 0 ||
  filter.accounts.size > 0;

export const toUsageFilter = (filter: UsageFilterState): UsageFilter => filter;

const toggled = <T,>(set: ReadonlySet<T>, value: T, on: boolean): ReadonlySet<T> => {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
};

/** A share as a person reads it: 100%, 37%, <1%. */
const shareText = (share: number): string =>
  share >= 0.995 ? "100%" : share < 0.005 ? "<1%" : `${Math.round(share * 100)}%`;

function FilterMenu(props: {
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly chosen: ReadonlySet<string>;
  readonly onChange: (value: string, on: boolean) => void;
  readonly onClear: () => void;
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
      <MenuPopup align="start" className="w-72 max-w-[calc(100vw-2rem)]">
        {/* First and pinned: the way back to everything, however long the list grows. */}
        {props.chosen.size > 0 ? (
          <>
            <MenuItem onClick={props.onClear} data-usage-filter-clear={props.label}>
              Show all {props.label.toLowerCase()}s
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <div className="max-h-72 overflow-y-auto">
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
        </div>
      </MenuPopup>
    </Menu>
  );
}

/**
 * Narrows the page by the harness that made the calls, the company whose model
 * answered, the model, and the accounts the user grouped. The options are what the
 * window holds, unnarrowed.
 */
export function UsageFilterBar(props: {
  readonly all: MergedUsage;
  readonly filter: UsageFilterState;
  readonly onChange: (filter: UsageFilterState) => void;
  readonly onEditAccounts: () => void;
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
  const accounts = all.accounts.flatMap((row) =>
    row.account === null ? [] : [{ value: row.account, label: row.account }],
  );
  const chips = [
    ...[...filter.accounts].map((value) => ({
      key: `a:${value}`,
      label: `Account: ${value}`,
      clear: () => onChange({ ...filter, accounts: toggled(filter.accounts, value, false) }),
    })),
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
        {accounts.length > 0 ? (
          <FilterMenu
            label="Account"
            onClear={() => onChange({ ...filter, accounts: new Set() })}
            options={accounts}
            chosen={filter.accounts}
            onChange={(value, on) =>
              onChange({ ...filter, accounts: toggled(filter.accounts, value, on) })
            }
          />
        ) : null}
        <FilterMenu
          label="Harness"
          onClear={() => onChange({ ...filter, harnesses: new Set() })}
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
          onClear={() => onChange({ ...filter, modelProviders: new Set() })}
          options={providers}
          chosen={filter.modelProviders}
          onChange={(value, on) =>
            onChange({ ...filter, modelProviders: toggled(filter.modelProviders, value, on) })
          }
        />
        <FilterMenu
          label="Model"
          onClear={() => onChange({ ...filter, models: new Set() })}
          options={models}
          chosen={filter.models}
          onChange={(value, on) =>
            onChange({ ...filter, models: toggled(filter.models, value, on) })
          }
        />
        <Button size="xs" variant="ghost" onClick={props.onEditAccounts} data-usage-accounts-edit>
          <UsersIcon className="size-3" aria-hidden />
          Accounts
        </Button>
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

/**
 * Usage by the accounts the user grouped, and by recorded provider for the rest. Each
 * member keeps the harness and the provider it recorded. Shares are of this row's
 * recorded tokens: not of a subscription allowance, and not of cost.
 */
export function AccountBreakdownTable(props: {
  readonly rows: ReadonlyArray<AccountTotals>;
  readonly onChoose: (row: AccountTotals) => void;
}) {
  return (
    <table className="w-full table-fixed text-sm" data-usage-provider-table>
      <colgroup>
        <col className="w-2/5" />
        <col className="w-2/5" />
        <col className="w-1/5" />
      </colgroup>
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="py-2 font-normal">Account or provider</th>
          <th className="py-2 font-normal">Share of recorded tokens</th>
          <th className="py-2 text-right font-normal">Tokens · cost</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.length === 0 ? (
          <tr>
            <td colSpan={3} className="py-6 text-center text-muted-foreground">
              No activity in this window.
            </td>
          </tr>
        ) : (
          props.rows.map((row) => (
            <tr
              key={row.account === null ? `p:${row.modelProvider ?? ""}` : `a:${row.account}`}
              className="cursor-pointer border-b border-border/50 align-top transition-colors hover:bg-muted/50"
              onClick={() => props.onChoose(row)}
              data-usage-account-row={row.account ?? ""}
            >
              <td className="py-2 text-foreground">
                {row.account !== null ? (
                  <span className="flex flex-col">
                    <span>{row.account}</span>
                    <span className="text-[11px] text-muted-foreground">
                      your grouping of {row.members.length} connection
                      {row.members.length === 1 ? "" : "s"}
                    </span>
                  </span>
                ) : (
                  <span className={row.modelProvider === null ? "text-muted-foreground" : ""}>
                    {modelProviderLabel(row.modelProvider, row.modelProviderSource)}
                  </span>
                )}
              </td>
              <td className="py-2 text-xs text-muted-foreground" data-usage-provider-through>
                <span className="flex h-1.5 w-full max-w-48 overflow-hidden rounded-full bg-muted">
                  {row.members.map((member) => (
                    <span
                      key={`${member.harness}:${member.modelProvider ?? ""}`}
                      style={{
                        width: `${member.tokenShare * 100}%`,
                        backgroundColor: PROVIDER_PRESENTATION[member.harness].color,
                      }}
                    />
                  ))}
                </span>
                <span className="mt-1 flex flex-col">
                  {row.members.map((member) => (
                    <span
                      key={`${member.harness}:${member.modelProvider ?? ""}`}
                      className="tabular-nums"
                    >
                      {PROVIDER_PRESENTATION[member.harness].label}
                      {row.account !== null
                        ? ` · ${member.modelProvider ?? "not recorded"}`
                        : ""}{" "}
                      {shareText(member.tokenShare)}
                    </span>
                  ))}
                </span>
              </td>
              <td className="py-2 text-right tabular-nums">
                <span className="flex flex-col">
                  <span>{formatTokens(row.totalTokens)}</span>
                  <span className="text-xs text-muted-foreground">
                    {row.records > 0 && row.unpricedRecords >= row.records
                      ? "Unpriced"
                      : formatUsd(row.costUsd)}
                  </span>
                </span>
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

const connectionKey = (harness: UsageProviderKind, modelProvider: string) =>
  `${harness}\u0000${modelProvider}`;

/**
 * Names the account each recorded connection belongs to. Only connections the user
 * names are grouped, and only exactly: a harness and the provider it recorded. The
 * mapping is saved on each selected environment, which applies it to its own usage.
 */
export function UsageAccountsEditor(props: {
  readonly all: MergedUsage;
  readonly environments: ReadonlyArray<EnvironmentUsageStatus>;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const connections = [
    ...new Map(
      props.all.models.flatMap((model) =>
        model.modelProvider === null
          ? []
          : [
              [
                connectionKey(model.provider, model.modelProvider),
                {
                  harness: model.provider,
                  modelProvider: model.modelProvider,
                  source: model.modelProviderSource,
                },
              ] as const,
            ],
      ),
    ).values(),
  ].toSorted(
    (a, b) =>
      PROVIDER_ORDER.indexOf(a.harness) - PROVIDER_ORDER.indexOf(b.harness) ||
      a.modelProvider.localeCompare(b.modelProvider),
  );
  const saved = new Map<string, string>();
  for (const environment of props.environments) {
    for (const [name, account] of Object.entries(environment.accounts)) {
      for (const member of account.members) {
        saved.set(connectionKey(member.harness, member.modelProvider), name);
      }
    }
  }
  const [names, setNames] = useState<ReadonlyMap<string, string>>(() => new Map(saved));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ReadonlyArray<string>>([]);
  const unrecorded = props.all.modelProviders.find((entry) => entry.modelProvider === null);

  const save = async () => {
    const accounts: Record<string, { members: Array<UsageAccount["members"][number]> }> = {};
    for (const connection of connections) {
      const name = names.get(connectionKey(connection.harness, connection.modelProvider))?.trim();
      if (!name) continue;
      (accounts[name] ??= { members: [] }).members.push({
        harness: connection.harness,
        modelProvider: connection.modelProvider,
      });
    }
    // Connections not seen in this window keep the account they were given.
    for (const environment of props.environments) {
      for (const [name, account] of Object.entries(environment.accounts)) {
        for (const member of account.members) {
          const key = connectionKey(member.harness, member.modelProvider);
          if (connections.some((item) => connectionKey(item.harness, item.modelProvider) === key))
            continue;
          const members = (accounts[name] ??= { members: [] }).members;
          if (!members.some((item) => connectionKey(item.harness, item.modelProvider) === key))
            members.push(member);
        }
      }
    }
    setBusy(true);
    const results = await Promise.all(
      props.environments.map(async (environment) => {
        const patch: Record<string, UsageAccount | null> = { ...accounts };
        for (const name of Object.keys(environment.accounts)) {
          if (!(name in accounts)) patch[name] = null;
        }
        try {
          const result = await updateSettings({
            environmentId: environment.environmentId as EnvironmentId,
            input: { patch: { usageAccounts: patch } },
          });
          return result._tag === "Success"
            ? `${environment.label}: saved.`
            : `${environment.label}: could not save. Try again.`;
        } catch {
          return `${environment.label}: could not save. Try again.`;
        }
      }),
    );
    setBusy(false);
    setOutcome(results);
    if (results.every((line) => line.endsWith("saved."))) props.onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={(open) => (busy ? undefined : props.onOpenChange(open))}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Accounts</DialogTitle>
          <DialogDescription>
            Give the same account name to connections you know share one account, such as one
            subscription used through two harnesses. Only the connections you name are grouped, and
            only exactly as recorded: another harness, or the same harness recording another
            provider, stays apart. Leave a name empty to keep a connection on its own.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-2">
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recorded provider in this window.</p>
          ) : null}
          {connections.map((connection) => {
            const key = connectionKey(connection.harness, connection.modelProvider);
            return (
              <label
                key={key}
                className="grid grid-cols-1 items-center gap-1 sm:grid-cols-[minmax(0,1fr)_14rem] sm:gap-3"
                data-usage-account-connection={key.replace("\u0000", ":")}
              >
                <span className="text-sm">
                  {PROVIDER_PRESENTATION[connection.harness].label}
                  <span className="text-muted-foreground">
                    {" · "}
                    {connection.source === "harness"
                      ? `${connection.modelProvider} (not recorded; the harness's only provider)`
                      : `records ${connection.modelProvider}`}
                  </span>
                </span>
                <Input
                  aria-label={`Account for ${PROVIDER_PRESENTATION[connection.harness].label}, ${connection.modelProvider}`}
                  placeholder="Not grouped"
                  value={names.get(key) ?? ""}
                  onChange={(event) =>
                    setNames((current) => new Map(current).set(key, event.target.value))
                  }
                />
              </label>
            );
          })}
          {unrecorded ? (
            <p className="text-xs text-muted-foreground">
              Usage with no recorded provider (
              {unrecorded.harnesses.map((kind) => PROVIDER_PRESENTATION[kind].label).join(", ")})
              cannot be grouped: its account is not known.
            </p>
          ) : null}
          {outcome.map((line) => (
            <p key={line} className="text-xs text-muted-foreground">
              {line}
            </p>
          ))}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="ghost" disabled={busy} onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void save()} data-usage-accounts-save>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
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
