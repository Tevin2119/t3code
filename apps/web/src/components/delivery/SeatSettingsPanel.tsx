import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { RotateCcwIcon } from "lucide-react";
import { useMemo } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { moveSeat, seatOfferFor, type SeatChoice, type SeatSettings } from "../../lib/delivery";
import {
  entriesForSeat,
  entryForHarness,
  harnessLabel,
  harnessOfDriver,
  seatValues,
  withTeamModels,
} from "../../lib/deliverySeats";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironment } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import type { ModelEsque } from "../chat/providerIconUtils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const TEAM_DEFAULT = "__team__";

/** A setting that cannot be changed for this seat, with the reason on hover. */
function Fixed(props: { readonly value: string; readonly why: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="text-xs text-muted-foreground" tabIndex={0} />}>
        {props.value}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.why}</TooltipPopup>
    </Tooltip>
  );
}

function Choice(props: {
  readonly label: string;
  readonly value: string | null;
  readonly baseValue: string | null;
  readonly baseLabel: string;
  readonly options: ReadonlyArray<string>;
  readonly why: string | null;
  readonly onChange: (value: string) => void;
}) {
  if (props.options.length <= 1) {
    return (
      <Fixed
        value={props.baseValue ?? props.options[0] ?? "Not set from outside"}
        why={props.why ?? "This harness takes one setting only."}
      />
    );
  }
  return (
    <Select
      value={props.value ?? TEAM_DEFAULT}
      onValueChange={(value) => props.onChange(value === TEAM_DEFAULT ? "" : String(value))}
    >
      <SelectTrigger aria-label={props.label} size="compact" variant="ghost" className="w-auto">
        <SelectValue>
          {props.value ?? (
            <span className="text-muted-foreground">
              {props.baseLabel}
              {props.baseValue ? `: ${props.baseValue}` : ""}
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        <SelectItem value={TEAM_DEFAULT}>
          {props.baseLabel}
          {props.baseValue ? `: ${props.baseValue}` : ""}
        </SelectItem>
        {props.options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** The harnesses and models of this environment, as the composer's own picker has them. */
function useSeatCatalog(environmentId: EnvironmentId | null) {
  const environment = useEnvironment(environmentId);
  const settings = useEnvironmentSettings((environmentId ?? "") as EnvironmentId);
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  return useMemo(() => {
    const entries = sortProviderInstanceEntries(
      applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
    ).filter((entry) => harnessOfDriver(entry.driverKind) !== null);
    return { entries, options: getCustomModelOptionsByInstance(settings, providers) };
  }, [providers, settings]);
}

/**
 * What each seat of a team runs on. A seat keeps its role; the harness, the
 * model, the reasoning and the access are chosen. What is left alone runs as
 * the team default, and what a harness cannot be told is shown with the
 * reason and cannot be set.
 */
export function SeatSettingsPanel(props: {
  readonly environmentId: EnvironmentId | null;
  readonly settings: ReadonlyArray<SeatSettings>;
  readonly chosen: Readonly<Record<string, SeatChoice>>;
  /**
   * `task`: the choices are laid over the team default. `defaults`: they are
   * the team default, laid over what the team's definition says.
   */
  readonly over?: "task" | "defaults";
  /** Omitted once the workflow has started: the settings are then a record. */
  readonly onChange?: ((seat: string, choice: SeatChoice) => void) | undefined;
  /** Shares of the builds, shown beside the seats that build. */
  readonly shares?: Readonly<Record<string, number>> | undefined;
}) {
  const catalog = useSeatCatalog(props.environmentId);
  const locked = props.onChange === undefined;
  const over = props.over ?? "task";
  const baseLabel = over === "task" ? "Team default" : "As defined";

  return (
    <div className="flex flex-col divide-y divide-border" data-delivery-seat-settings>
      {props.settings.map((item) => {
        const base = over === "task" ? item.now : item.defined;
        const chosen = locked ? {} : (props.chosen[item.seat] ?? {});
        const values = locked ? item.effective : seatValues(base, chosen);
        const offer = locked ? item.may : seatOfferFor({ ...item, now: base }, chosen);
        const entries = entriesForSeat(catalog.entries, item);
        const entry = entryForHarness(catalog.entries, values.harness);
        const changed = Object.keys(chosen).length > 0;
        const share = props.shares?.[item.seat];
        const options = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>(
          entries.map((candidate) => {
            const listed = catalog.options.get(candidate.instanceId) ?? [];
            // The models the team names for the seat belong to the harness it is defined on.
            return [
              candidate.instanceId,
              harnessOfDriver(candidate.driverKind) === item.defined.harness
                ? withTeamModels(listed, item.models, (slug) => ({ slug, name: slug }))
                : listed,
            ];
          }),
        );
        const set = (choice: SeatChoice) => props.onChange?.(item.seat, choice);

        return (
          <div
            key={item.seat}
            className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0"
            data-seat={item.seat}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 text-xs">
                <span className="font-medium">{item.title}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {item.role}
                  {share !== undefined ? ` · ${share}% of the builds` : ""}
                </span>
              </span>
              {locked ? null : changed ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Put ${item.title} back to ${baseLabel.toLowerCase()}`}
                        onClick={() => set({})}
                      />
                    }
                  >
                    <RotateCcwIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Back to {baseLabel.toLowerCase()}</TooltipPopup>
                </Tooltip>
              ) : (
                <Badge size="sm" variant="outline" className="shrink-0 text-muted-foreground">
                  {baseLabel}
                </Badge>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
              {locked ? (
                <span className="text-xs" data-seat-runs-on>
                  {harnessLabel(values.harness)}, {values.model ?? "its own model"}
                </span>
              ) : entry ? (
                <ProviderModelPicker
                  activeInstanceId={entry.instanceId}
                  model={values.model ?? ""}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={options}
                  size="xs"
                  triggerVariant="outline"
                  triggerAriaLabel={`Harness and model for ${item.title}`}
                  {...(offer.model
                    ? {}
                    : { triggerLabel: `${harnessLabel(values.harness)}, its own model` })}
                  onInstanceModelChange={(instanceId, model) => {
                    const picked = entries.find((candidate) => candidate.instanceId === instanceId);
                    const harness = picked ? harnessOfDriver(picked.driverKind) : null;
                    if (!harness) return;
                    // Picking what the seat already runs on by default is no choice at all.
                    if (harness === base.harness && model === base.model) {
                      const { harness: _harness, model: _model, ...rest } = chosen;
                      set(rest);
                      return;
                    }
                    set(moveSeat({ ...item, now: base }, chosen, { harness, model }));
                  }}
                />
              ) : (
                <Fixed
                  value={`${harnessLabel(values.harness)}, ${values.model ?? "its own model"}`}
                  why="This harness is not set up in T3 Code on this environment, so it cannot be chosen from here. The engine still runs the seat on it."
                />
              )}

              <Choice
                label={`Reasoning for ${item.title}`}
                value={locked ? values.reasoning : (chosen.reasoning ?? null)}
                baseValue={locked ? values.reasoning : chosen.harness ? null : base.reasoning}
                baseLabel={locked ? "Reasoning" : baseLabel}
                options={locked ? [] : offer.reasoning}
                why={
                  locked
                    ? "Set when the workflow started."
                    : (item.why.reasoning ??
                      `${harnessLabel(values.harness)} takes no reasoning setting from outside.`)
                }
                onChange={(value) => set({ ...chosen, reasoning: value })}
              />
              <Choice
                label={`Access for ${item.title}`}
                value={locked ? values.access : (chosen.access ?? null)}
                baseValue={
                  locked ? values.access : chosen.harness ? (offer.access[0] ?? null) : base.access
                }
                baseLabel={locked ? "Access" : baseLabel}
                options={locked ? [] : offer.access}
                why={
                  locked
                    ? "Set when the workflow started."
                    : (item.why.access ??
                      `${harnessLabel(values.harness)} runs with full access only.`)
                }
                onChange={(value) => set({ ...chosen, access: value })}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
