import type { EnvironmentId } from "@t3tools/contracts";
import { PlusIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useId } from "react";

import { MOST_FALLBACKS, type SeatFallback, type SeatSettings } from "../../lib/delivery";
import { entryForHarness, harnessLabel } from "../../lib/deliverySeats";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSeatCatalog } from "./SeatSettingsPanel";

const describe = (list: ReadonlyArray<SeatFallback>) =>
  list
    .map((item) => `${harnessLabel(item.harness)}${item.model ? ` ${item.model}` : ""}`)
    .join(", then ");

/**
 * Who takes a seat's place, in order, when it cannot answer. A usage limit
 * moves the step to the next in the list; a harness that cannot sign in or
 * has no credit moves it to the next on another harness. The seat keeps its
 * role, its rules and its access. `value` null means nothing is named here,
 * and the seat has what it is laid over: `inherited`.
 */
export function FallbacksEditor(props: {
  readonly environmentId: EnvironmentId | null;
  readonly item: SeatSettings;
  readonly value: ReadonlyArray<SeatFallback> | null;
  readonly inherited: ReadonlyArray<SeatFallback>;
  readonly inheritedLabel: string;
  readonly onChange: (next: ReadonlyArray<SeatFallback> | null) => void;
}) {
  const catalog = useSeatCatalog(props.environmentId);
  const id = useId();
  const { item } = props;
  if (!item.fallbacksAllowed) {
    return (
      <p className="text-[11px] text-muted-foreground" data-seat-fallbacks="none">
        {item.why.harness
          ? "No fallbacks: the team's policy keeps this seat on its harness."
          : "No fallbacks: the QA gate counts each provider once, so a seat of the gate that cannot answer is counted as missing."}
      </p>
    );
  }
  const harnesses =
    item.may.harness.length > 0 ? item.may.harness : [item.now.harness ?? item.harness];
  const list = props.value;
  const set = (next: ReadonlyArray<SeatFallback>) => props.onChange(next);
  const modelsOf = (harness: string) => {
    const entry = entryForHarness(catalog.entries, harness);
    return entry ? (catalog.options.get(entry.instanceId) ?? []).map((option) => option.slug) : [];
  };
  const takesModel = (harness: string) =>
    harness === (item.now.harness ?? item.harness)
      ? item.may.model
      : (item.byHarness[harness]?.model ?? false);

  if (list === null) {
    return (
      <div
        className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground"
        data-seat-fallbacks="inherited"
      >
        <span>
          Fallbacks: {props.inherited.length > 0 ? describe(props.inherited) : "none named"} (
          {props.inheritedLabel.toLowerCase()})
        </span>
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Name fallbacks for ${item.title}`}
          onClick={() =>
            set(
              props.inherited.length > 0
                ? props.inherited
                : [
                    {
                      harness:
                        harnesses.find((name) => name !== (item.now.harness ?? item.harness)) ??
                        harnesses[0]!,
                      model: null,
                    },
                  ],
            )
          }
        >
          <PlusIcon />
          Name fallbacks
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1" data-seat-fallbacks="set">
      <span className="text-[11px] text-muted-foreground">
        Fallbacks, in order. A usage limit moves the step to the next; a harness that cannot sign in
        moves it to the next on another harness.
      </span>
      {list.map((fallback, index) => {
        const models = modelsOf(fallback.harness);
        return (
          // oxlint-disable-next-line no-array-index-key -- rows are positions in an ordered list
          <div key={index} className="flex flex-wrap items-center gap-1">
            <span className="w-4 text-[11px] text-muted-foreground">{index + 1}.</span>
            <Select
              value={fallback.harness}
              onValueChange={(value) =>
                set(
                  list.map((row, at) =>
                    at === index ? { harness: String(value), model: null } : row,
                  ),
                )
              }
            >
              <SelectTrigger
                aria-label={`Fallback ${index + 1} harness for ${item.title}`}
                size="compact"
                className="w-auto"
              >
                <SelectValue>{harnessLabel(fallback.harness)}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {harnesses.map((harness) => (
                  <SelectItem key={harness} value={harness}>
                    {harnessLabel(harness)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {takesModel(fallback.harness) ? (
              <>
                <Input
                  aria-label={`Fallback ${index + 1} model for ${item.title}`}
                  className="h-7 w-48 text-xs"
                  placeholder="Model"
                  list={`${id}-${index}`}
                  value={fallback.model ?? ""}
                  onChange={(event) =>
                    set(
                      list.map((row, at) =>
                        at === index ? { ...row, model: event.target.value.trim() || null } : row,
                      ),
                    )
                  }
                />
                <datalist id={`${id}-${index}`}>
                  {models.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </>
            ) : (
              <span className="text-[11px] text-muted-foreground">its own model</span>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove fallback ${index + 1} for ${item.title}`}
              onClick={() => set(list.filter((_, at) => at !== index))}
            >
              <XIcon />
            </Button>
          </div>
        );
      })}
      <div className="flex items-center gap-1">
        <Button
          size="xs"
          variant="ghost"
          disabled={list.length >= MOST_FALLBACKS}
          onClick={() => set([...list, { harness: harnesses[0]!, model: null }])}
        >
          <PlusIcon />
          Add a fallback
        </Button>
        <Button size="xs" variant="ghost" onClick={() => props.onChange(null)}>
          <RotateCcwIcon />
          Back to {props.inheritedLabel.toLowerCase()}
        </Button>
      </div>
    </div>
  );
}
