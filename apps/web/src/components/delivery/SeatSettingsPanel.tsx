import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { RotateCcwIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  moveSeat,
  seatIsOn,
  seatSources,
  seatOfferFor,
  type SeatChoice,
  type SeatSettings,
} from "../../lib/delivery";
import {
  entriesForSeat,
  entryForHarness,
  harnessLabel,
  harnessOfDriver,
  seatValues,
  withTeamModels,
} from "../../lib/deliverySeats";
import { cn } from "../../lib/utils";
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
import { Switch } from "../ui/switch";
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
export function useSeatCatalog(environmentId: EnvironmentId | null) {
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
 * The seats of a team: which take part, and what each runs on. A seat keeps
 * its role. It is switched on or off, and the harness, the model, the
 * reasoning and the access it runs with are chosen. What is left alone runs
 * as the team default. A seat that is off keeps what is set for it.
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
  /** Seats the chosen flow would use. The others are on, and the flow has no part for them. */
  readonly taking?: ReadonlyArray<string> | undefined;
  /** Only the switches: what each seat runs on is set somewhere else. */
  readonly switchesOnly?: boolean;
  /** More to set for a seat, shown under it: its fallbacks. */
  readonly renderExtra?: ((item: SeatSettings) => ReactNode) | undefined;
}) {
  const catalog = useSeatCatalog(props.environmentId);
  const locked = props.onChange === undefined;
  const over = props.over ?? "task";
  const base = over === "task" ? "now" : "defined";
  const baseLabel = over === "task" ? "Team default" : "As defined";
  const on = props.settings.filter((item) =>
    locked ? item.effective.active !== "off" : seatIsOn(item, props.chosen[item.seat] ?? {}, base),
  ).length;

  return (
    <div className="flex flex-col gap-1" data-delivery-seat-settings>
      <p className="text-[11px] text-muted-foreground" data-delivery-seats-on>
        {on} of {props.settings.length} seats switched on
      </p>
      <div className="flex flex-col divide-y divide-border">
        {props.settings.map((item) => {
          const from = item[base];
          const chosen = locked ? {} : (props.chosen[item.seat] ?? {});
          const values = locked ? item.effective : seatValues(from, chosen);
          const isOn = values.active !== "off";
          const offer = locked ? item.may : seatOfferFor({ ...item, now: from }, chosen);
          const entries = entriesForSeat(catalog.entries, item);
          const entry = entryForHarness(catalog.entries, values.harness);
          // Whether the seat is on is not a setting of what it runs on.
          const { active: _active, ...runsOn } = chosen;
          const changed = Object.keys(runsOn).length > 0;
          const share = props.shares?.[item.seat];
          const idle = isOn && props.taking !== undefined && !props.taking.includes(item.seat);
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
              className={cn("flex flex-col gap-1 py-2 first:pt-0 last:pb-0", !isOn && "opacity-60")}
              data-seat={item.seat}
              data-seat-on={isOn ? "true" : "false"}
            >
              <div className="flex items-center gap-2">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Switch
                        aria-label={`${item.title} takes part`}
                        checked={isOn}
                        disabled={locked}
                        onCheckedChange={(next) => {
                          const wanted = next ? "on" : "off";
                          // Back to what it is set to is no choice at all.
                          set({
                            ...chosen,
                            active: wanted === (from.active ?? "on") ? "" : wanted,
                          });
                        }}
                        data-seat-switch
                      />
                    }
                  />
                  <TooltipPopup side="top">
                    {isOn
                      ? `${item.title} takes part. Switched off, it keeps what is set for it and is asked nothing.`
                      : `${item.title} is switched off. It keeps what is set for it and is asked nothing.`}
                  </TooltipPopup>
                </Tooltip>
                <span className="min-w-0 flex-1 text-xs">
                  <span className="font-medium">{item.title}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {item.duties.length > 0 ? item.duties.join(", ") : item.role}
                    {share !== undefined ? ` · ${share}% of the builds` : ""}
                  </span>
                </span>
                {idle ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Badge size="sm" variant="outline" className="shrink-0" tabIndex={0} />
                      }
                    >
                      no part in this flow
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      The flow that is chosen has no part for what this seat does. It is asked
                      nothing in it, on or off.
                    </TooltipPopup>
                  </Tooltip>
                ) : null}
                {props.switchesOnly ? null : locked ? null : changed ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Put ${item.title} back to ${baseLabel.toLowerCase()}`}
                          onClick={() => set(chosen.active ? { active: chosen.active } : {})}
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

              {props.switchesOnly ? (
                <p className="pl-10 text-[11px] text-muted-foreground" data-seat-runs-on>
                  {harnessLabel(values.harness)}, {values.model ?? "its own model"}
                  {values.reasoning ? `, ${values.reasoning}` : ""}
                  {values.access && values.access !== "full" ? `, ${values.access}` : ""}
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 pl-10">
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
                        const picked = entries.find(
                          (candidate) => candidate.instanceId === instanceId,
                        );
                        const harness = picked ? harnessOfDriver(picked.driverKind) : null;
                        if (!harness) return;
                        // Picking what the seat already runs on by default is no choice at all.
                        if (harness === from.harness && model === from.model) {
                          const { harness: _harness, model: _model, ...rest } = chosen;
                          set(rest);
                          return;
                        }
                        set(moveSeat({ ...item, now: from }, chosen, { harness, model }));
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
                    baseValue={locked ? values.reasoning : chosen.harness ? null : from.reasoning}
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
                      locked
                        ? values.access
                        : chosen.harness
                          ? (offer.access[0] ?? null)
                          : from.access
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
              )}
              {over === "task" && !locked && seatSources(item).length > 0 ? (
                <p className="pl-10 text-[11px] text-muted-foreground" data-seat-source>
                  {baseLabel} set by {seatSources(item).join(" and ")}
                </p>
              ) : null}
              {props.renderExtra && !props.switchesOnly ? (
                <div className="pl-10">{props.renderExtra(item)}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
