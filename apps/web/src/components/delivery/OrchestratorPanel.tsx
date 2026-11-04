import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { parseSeatSetup, type DeliveryFlow, type SeatSetup } from "../../lib/delivery";
import { cn } from "../../lib/utils";
import { useDeliveryAct } from "../../state/delivery";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** What a flow would do with the seats as they are set, read from the engine. */
export function useFlowPreview(
  environmentId: EnvironmentId | null,
  team: string | null,
  flow: string | null,
  seats: Readonly<Record<string, Record<string, string>>>,
): SeatSetup | null {
  const act = useDeliveryAct(environmentId, "flow preview");
  const [preview, setPreview] = useState<SeatSetup | null>(null);
  const sent = JSON.stringify(seats);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Debounce the engine preview request and cancel its timer and response on cleanup.
  useEffect(() => {
    if (!team) return;
    let cancelled = false;
    // A short wait, so that a row of switches is asked about once.
    const timer = window.setTimeout(() => {
      void act(`/api/teams/${team}/setup`, { flow, seats: JSON.parse(sent) }).then((result) => {
        if (cancelled || !result.ok) return;
        setPreview(parseSeatSetup(result.body));
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [act, flow, sent, team]);
  return preview?.team === team ? preview : null;
}

export function FlowChoice(props: {
  readonly flows: ReadonlyArray<DeliveryFlow>;
  readonly value: string;
  readonly onChange: (flow: string) => void;
}) {
  return (
    <div
      className="grid gap-1.5 sm:grid-cols-2"
      role="radiogroup"
      aria-label="Flow"
      data-flow-choice
    >
      {props.flows.map((flow) => {
        const chosen = flow.id === props.value;
        const card = (
          <button
            key={flow.id}
            type="button"
            role="radio"
            aria-checked={chosen}
            disabled={!flow.offered}
            data-flow={flow.id}
            data-flow-chosen={chosen ? "true" : "false"}
            onClick={() => props.onChange(flow.id)}
            className={cn(
              "flex cursor-pointer flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left text-xs transition-colors",
              chosen ? "border-primary bg-primary/5" : "border-border hover:bg-accent",
              !flow.offered && "cursor-not-allowed opacity-50 hover:bg-transparent",
            )}
          >
            <span className="flex items-center gap-1.5 font-medium">
              {flow.title}
              {flow.offered && !flow.ready && chosen ? (
                <Badge size="sm" variant="warning">
                  lacks seats
                </Badge>
              ) : null}
            </span>
            <span className="text-2xs text-muted-foreground">
              {flow.stages.join(", ")}. Stops at: {flow.stop}.
            </span>
          </button>
        );
        return (
          <Tooltip key={flow.id}>
            <TooltipTrigger render={<span className="contents" />}>{card}</TooltipTrigger>
            <TooltipPopup side="top" className="max-w-80">
              {flow.offered ? flow.summary : `${flow.why}.`}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
