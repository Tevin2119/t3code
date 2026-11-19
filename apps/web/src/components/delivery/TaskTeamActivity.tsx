import {
  isOrchestrationV2WorkActive,
  ProviderDriverKind,
  type EnvironmentId,
  type OrchestrationV2TurnItemStatus,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { repeatKeys, type CouncilSeat, type SeatLive, type TaskView } from "../../lib/delivery";
import { TASK_PIPELINE_STAGES, taskPipelineStage } from "../../lib/deliveryPipeline";
import { driverOfHarness, entryForHarness, harnessLabel } from "../../lib/deliverySeats";
import { cn } from "../../lib/utils";
import { AgentElapsed } from "../chat/AgentElapsed";
import { SubagentTooltipContent } from "../chat/SubagentTooltipContent";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import {
  ThreadRelationshipIcon,
  threadRelationshipStatusLabel,
} from "../chat/ThreadRelationshipIcon";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { WizardStepMarker } from "../ui/wizard";
import { SeatSettingsPanel, useSeatCatalog } from "./SeatSettingsPanel";

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

/** What a seat at work last did, newest last: the tools it called and what it said. */
function SeatNow(props: { readonly live: SeatLive }) {
  const items = props.live.items.slice(-4);
  const keys = repeatKeys(items.map((item) => `${item.kind}:${item.text}`));
  return (
    <ul className="mt-0.5 flex flex-col gap-0.5 border-l border-border pl-2" data-seat-live>
      {items.map((item, index) => (
        <li
          key={keys[index]}
          className={cn(
            "text-3xs break-words",
            item.kind === "said" ? "text-foreground/80" : "font-mono text-muted-foreground",
          )}
        >
          {item.text}
        </li>
      ))}
    </ul>
  );
}

/** Where the task is in the engine's flow. It shows the step; it asks nothing. */
function TaskPipelineStrip(props: { readonly task: TaskView }) {
  const stage = taskPipelineStage(props.task);
  // A settled step is done, so its marker shows the check the steps ahead of it show.
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
            aria-current={index === stage.index ? "step" : undefined}
          >
            <WizardStepMarker index={index} currentStep={current} />
            <span className="sr-only">
              {label}
              {index < current ? ", done" : index === stage.index ? ", now" : ""}
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

/** One seat as a native agent row: harness and status, what it waits on, and how long it ran. */
function SeatRow(props: {
  readonly seat: CouncilSeat;
  readonly catalog: ReturnType<typeof useSeatCatalog>;
}) {
  const { seat, catalog } = props;
  const m = useMessages();
  const status = seatStatus(seat.activity);
  const entry = entryForHarness(catalog.entries, seat.harness);
  const provider = catalog.providers.find((item) => item.instanceId === entry?.instanceId);
  const fallback = driverOfHarness(seat.harness);
  const driver = entry?.driverKind ?? (fallback ? ProviderDriverKind.make(fallback) : undefined);
  const live = isOrchestrationV2WorkActive(status);
  const timing = {
    status,
    startedAt: seat.live?.started ?? null,
    completedAt: live ? null : (seat.live?.updated ?? null),
  };
  const detail = seat.blockedBy
    ? `waits for ${seat.blockedBy}`
    : seat.verdict
      ? `verdict ${seat.verdict}`
      : seat.activity === "unavailable"
        ? "unavailable"
        : (seat.stage ?? threadRelationshipStatusLabel(status, m));
  const latest = seat.live?.items.at(-1)?.text ?? null;
  return (
    <li data-task-seat={seat.seat} data-seat-activity={seat.activity}>
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              className="cursor-default"
              render={<div tabIndex={0} />}
            />
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
              "shrink-0 truncate text-2xs font-normal",
              seat.activity === "unavailable" ? "text-destructive" : "text-muted-foreground",
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
        <ThreadHoverCardPopup side="right">
          <SubagentTooltipContent
            title={seat.seat}
            model={seat.actualModel ?? seat.requestedModel}
            providerInstanceId={entry?.instanceId ?? (seat.harness as ProviderInstanceId)}
            origin="provider_native"
            provider={provider}
            providers={catalog.providers}
            driver={driver}
            elapsed={<AgentElapsed agent={timing} />}
            status={status}
            result={seat.waitingWhy ?? (seat.verdict ? `verdict ${seat.verdict}` : null)}
            progress={latest}
          />
        </ThreadHoverCardPopup>
      </Tooltip>
      <div className="ps-9 pe-2.5 pb-1">
        <span className="block text-3xs text-muted-foreground">
          {harnessLabel(seat.harness)}, {seat.requestedModel ?? "its own model"}
          {seat.reasoning ? `, ${seat.reasoning}` : ""}
          {seat.access && seat.access !== "full" ? `, ${seat.access}` : ""}
        </span>
        {seat.waitingWhy ? (
          <span className="block text-3xs text-muted-foreground" data-seat-waiting-why>
            {seat.waitingWhy}
          </span>
        ) : null}
        {seat.live && seat.live.items.length > 0 ? <SeatNow live={seat.live} /> : null}
      </div>
    </li>
  );
}

/**
 * The task's team in the left pane, the way a thread's lineage shows its agents: one row per
 * seat with its harness and status, and above them where the task is in the flow.
 */
export function TaskTeamActivity(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: TaskView;
}) {
  const { task } = props;
  const catalog = useSeatCatalog(props.environmentId);
  const seats = task.council?.seats ?? [];
  const running = seats.filter((seat) => seat.activity === "active").length;
  const team = `Team ${task.team}${task.defaults > 0 ? `, defaults r${task.defaults}` : ""}`;
  return (
    <div className="flex flex-col">
      <ThreadDetailsSection
        headingId={`task-pipeline-${task.id}`}
        title="Flow"
        separated={false}
        data-task-pipeline-section
      >
        <TaskPipelineStrip task={task} />
      </ThreadDetailsSection>
      <ThreadDetailsSection
        headingId={`task-team-${task.id}`}
        title={running > 0 ? `${team} · ${running} running` : team}
        data-task-roster
      >
        {task.council ? (
          <ul className="m-0 flex list-none flex-col p-0">
            {seats.map((seat) => (
              <SeatRow key={seat.seat} seat={seat} catalog={catalog} />
            ))}
          </ul>
        ) : (
          <div className="px-2.5">
            <SeatSettingsPanel
              environmentId={props.environmentId}
              settings={task.settings}
              chosen={{}}
            />
          </div>
        )}
      </ThreadDetailsSection>
    </div>
  );
}
