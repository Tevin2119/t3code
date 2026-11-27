import type { SideThreadOpenIntent } from "@t3tools/client-runtime/side-thread";
import {
  isOrchestrationV2WorkActive,
  ProviderDriverKind,
  type OrchestrationV2TurnItemStatus,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { msg, useMessages } from "gt-react";

import type { CouncilSeat, TaskView } from "../../lib/delivery";
import { TASK_PIPELINE_STAGES, taskPipelineStage } from "../../lib/deliveryPipeline";
import { driverOfHarness, entryForHarness } from "../../lib/deliverySeats";
import { useSideThreadTrigger } from "../../hooks/useSideThreadTrigger";
import { cn } from "../../lib/utils";
import { AgentElapsed } from "../chat/AgentElapsed";
import { SubagentTooltipContent } from "../chat/SubagentTooltipContent";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import {
  ThreadRelationshipIcon,
  threadRelationshipStatusLabel,
} from "../chat/ThreadRelationshipIcon";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { WizardStepMarker } from "../ui/wizard";
import type { useSeatCatalog } from "./SeatSettingsPanel";

/** A seat's activity in the words native agent rows use. */
const SEAT_STATUS: Readonly<Record<string, OrchestrationV2TurnItemStatus>> = {
  active: "running",
  queued: "pending",
  waiting: "waiting",
  completed: "completed",
  unavailable: "idle",
};

const seatStatus = (activity: string): OrchestrationV2TurnItemStatus =>
  SEAT_STATUS[activity] ?? "idle";

/** Where the task is in the engine's flow. It shows the step; it asks nothing. */
export function TaskPipelineStrip(props: { readonly task: TaskView }) {
  const stage = taskPipelineStage(props.task);
  // A settled step is done, so its marker shows the check the steps ahead of it show, and the
  // tinted marker moves to the step after it. The step a screen reader hears as current is the
  // tinted one; once Live is settled nothing is tinted, so no step is current.
  const current = stage.settled ? stage.index + 1 : stage.index;
  return (
    <div className="flex flex-col gap-1.5 px-2.5" data-task-pipeline={stage.label}>
      <ol aria-label="Where the task is in the flow" className="flex items-center gap-1">
        {TASK_PIPELINE_STAGES.map((label, index) => (
          <li
            key={label}
            className={cn(
              "flex items-center gap-1",
              index < TASK_PIPELINE_STAGES.length - 1 && "flex-1",
            )}
            aria-current={index === current ? "step" : undefined}
          >
            <WizardStepMarker index={index} currentStep={current} />
            <span className="sr-only">
              {label}
              {index < current
                ? ", done"
                : index === current
                  ? stage.settled
                    ? ", next"
                    : ", now"
                  : ""}
            </span>
            {index < TASK_PIPELINE_STAGES.length - 1 ? (
              <span
                aria-hidden
                className={cn("h-px min-w-1 flex-1", index < current ? "bg-primary" : "bg-border")}
              />
            ) : null}
          </li>
        ))}
      </ol>
      <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium text-foreground">{stage.label}</span>
        {stage.detail ? (
          <Badge size="sm" variant={stage.tone} data-task-pipeline-detail>
            {stage.detail}
          </Badge>
        ) : null}
      </p>
    </div>
  );
}

/**
 * A seat's own conversation as a row of the task thread's lineage, in the look of a subagent row:
 * harness and status, what it waits on, and how long it ran. It opens as a subagent row does.
 */
export function SeatThreadRow(props: {
  readonly seat: CouncilSeat;
  readonly catalog: ReturnType<typeof useSeatCatalog>;
  readonly onOpen: (intent: SideThreadOpenIntent) => void;
}) {
  const { seat, catalog } = props;
  const m = useMessages();
  const trigger = useSideThreadTrigger();
  // A step T3's restart cut short never reads as running, even while the engine runs it again.
  const status = seat.cutByT3 ? "interrupted" : seatStatus(seat.activity);
  const actualModel = seat.attestedModel?.model ?? seat.actualModel;
  const harness = seat.attestedModel?.harness ?? seat.harness;
  const entry = entryForHarness(catalog.entries, harness);
  const provider = catalog.providers.find((item) => item.instanceId === entry?.instanceId);
  const fallback = driverOfHarness(harness);
  const driver = entry?.driverKind ?? (fallback ? ProviderDriverKind.make(fallback) : undefined);
  const live = isOrchestrationV2WorkActive(status);
  const timing = {
    status,
    startedAt: seat.live?.started ?? null,
    completedAt: live ? null : (seat.live?.updated ?? null),
  };
  const detail = seat.cutByT3
    ? m(msg("{stage} cut short by a T3 restart, needs you", { stage: seat.cutByT3 }))
    : seat.blockedBy
      ? `waits for ${seat.blockedBy}`
      : seat.verdict
        ? `verdict ${seat.verdict}`
        : seat.activity === "unavailable"
          ? "unavailable"
          : (seat.stage ?? threadRelationshipStatusLabel(status, m));
  return (
    <li
      className="group relative flex h-8 items-center rounded-lg"
      data-task-seat={seat.seat}
      data-seat-activity={seat.activity}
      data-seat-cut-by-t3={seat.cutByT3 ?? undefined}
    >
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl size="sm" variant="ghost" part="row" {...trigger(props.onOpen)} />
          }
        >
          <ThreadRelationshipIcon
            driver={driver}
            provider={provider}
            providerEntries={catalog.entries}
            status={status}
          />
          <span className="min-w-0 flex-1 truncate text-left text-sm font-medium leading-4 text-foreground/85">
            {seat.seat}
          </span>
          <span className="sr-only">{seat.activity}</span>
          <span
            className={cn(
              // At most half the row, so a long detail ellipsizes and the seat name keeps the rest.
              "min-w-0 max-w-1/2 truncate text-2xs font-normal",
              seat.activity === "unavailable"
                ? "text-destructive"
                : seat.cutByT3
                  ? "text-warning-foreground"
                  : "text-muted-foreground",
            )}
            data-seat-detail
          >
            {detail}
          </span>
          {live && timing.startedAt ? (
            <span className="shrink-0 text-2xs font-normal tabular-nums text-muted-foreground">
              <AgentElapsed agent={timing} compact />
            </span>
          ) : null}
        </TooltipTrigger>
        <ThreadHoverCardPopup side="left">
          <SubagentTooltipContent
            title={seat.seat}
            model={actualModel ?? seat.requestedModel}
            providerInstanceId={entry?.instanceId ?? (seat.harness as ProviderInstanceId)}
            origin="provider_native"
            provider={provider}
            providers={catalog.providers}
            driver={driver}
            elapsed={<AgentElapsed agent={timing} />}
            status={status}
            result={seat.waitingWhy ?? (seat.verdict ? `verdict ${seat.verdict}` : null)}
            progress={seat.live?.items.at(-1)?.text ?? null}
          />
        </ThreadHoverCardPopup>
      </Tooltip>
    </li>
  );
}
