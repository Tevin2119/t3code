import {
  isOrchestrationV2WorkActive,
  ProviderDriverKind,
  type EnvironmentId,
  type OrchestrationV2TurnItemStatus,
  type ProviderInstanceId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { repeatKeys, type CouncilSeat, type SeatLive, type TaskView } from "../../lib/delivery";
import { TASK_PIPELINE_STAGES, taskPipelineStage } from "../../lib/deliveryPipeline";
import { driverOfHarness, entryForHarness, harnessLabel } from "../../lib/deliverySeats";
import { sameThread } from "../../lib/taskConversation";
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

/** The seats' own conversations, when the task has any: which a seat's row opens, and which is open. */
export interface SeatConversations {
  readonly thread: (seat: string) => ScopedThreadRef | null;
  readonly current: ScopedThreadRef | null;
  readonly open: (thread: ScopedThreadRef) => void;
}

/**
 * One seat as a native agent row: harness and status, what it waits on, and how long it ran. A
 * seat the lead has handed work to opens its own conversation, as a subagent row does.
 */
function SeatRow(props: {
  readonly seat: CouncilSeat;
  readonly catalog: ReturnType<typeof useSeatCatalog>;
  readonly conversations?: SeatConversations | undefined;
  readonly openConversationLabel?: string | undefined;
}) {
  const { seat, catalog, conversations } = props;
  const thread = conversations?.thread(seat.seat) ?? null;
  const showOpenAction = thread !== null && props.openConversationLabel !== undefined;
  const m = useMessages();
  const status = seatStatus(seat.activity);
  const actualModel = seat.attestedModel?.model ?? seat.actualModel;
  const harness =
    props.openConversationLabel !== undefined
      ? (seat.attestedModel?.harness ?? seat.harness)
      : seat.harness;
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
  const detail = seat.blockedBy
    ? `waits for ${seat.blockedBy}`
    : seat.verdict
      ? `verdict ${seat.verdict}`
      : seat.activity === "unavailable"
        ? "unavailable"
        : (seat.stage ?? threadRelationshipStatusLabel(status, m));
  const latest = seat.live?.items.at(-1)?.text ?? null;
  const seatName = (
    <span className="min-w-0 flex-1 truncate text-left text-sm font-medium leading-4 text-foreground/85">
      {seat.seat}
    </span>
  );
  return (
    <li
      data-task-seat={seat.seat}
      data-seat-activity={seat.activity}
      data-seat-conversation={thread ? "yes" : "no"}
    >
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              multiline={showOpenAction}
              render={thread ? undefined : <div tabIndex={0} />}
              aria-current={sameThread(thread, conversations?.current ?? null) ? "true" : undefined}
              onClick={thread ? () => conversations?.open(thread) : undefined}
            />
          }
        >
          <ThreadRelationshipIcon
            driver={driver}
            provider={provider}
            providerEntries={catalog.entries}
            status={status}
          />
          {showOpenAction ? (
            <span className="flex min-w-0 flex-1 flex-col text-left">
              {seatName}
              <span className="whitespace-normal text-2xs leading-4 font-normal text-primary">
                {props.openConversationLabel}
              </span>
            </span>
          ) : (
            seatName
          )}
          <span className="sr-only">{seat.activity}</span>
          <span
            className={cn(
              // At most half the row, so a long detail ellipsizes and the seat name keeps the rest.
              "min-w-0 max-w-1/2 truncate text-2xs font-normal",
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
            model={actualModel ?? seat.requestedModel}
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
          {harnessLabel(harness)},{" "}
          {props.openConversationLabel !== undefined && actualModel
            ? actualModel
            : (seat.requestedModel ?? "its own model")}
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
 * The task's team, the way a thread's lineage shows its agents: one row per seat with its harness
 * and status, and above them, unless `flow` is false, where the task is in the flow.
 */
export function TaskTeamActivity(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: TaskView;
  readonly conversations?: SeatConversations | undefined;
  readonly flow?: boolean | undefined;
  readonly conversationLabels?: { readonly title: string; readonly open: string } | undefined;
}) {
  const { task } = props;
  const catalog = useSeatCatalog(props.environmentId);
  const seats = task.council?.seats ?? [];
  const running = seats.filter((seat) => seat.activity === "active").length;
  const team = `Team ${task.team}${task.defaults > 0 ? `, defaults r${task.defaults}` : ""}`;
  return (
    <div className="flex flex-col">
      {props.flow === false ? null : (
        <ThreadDetailsSection
          headingId={`task-pipeline-${task.id}`}
          title="Flow"
          separated={false}
          data-task-pipeline-section
        >
          <TaskPipelineStrip task={task} />
        </ThreadDetailsSection>
      )}
      <ThreadDetailsSection
        headingId={`${props.conversationLabels ? "task-seats" : "task-team"}-${task.id}`}
        title={
          props.conversationLabels?.title ?? (running > 0 ? `${team} · ${running} running` : team)
        }
        data-task-roster
      >
        {task.council ? (
          <ul className="m-0 flex list-none flex-col p-0">
            {seats.map((seat) => (
              <SeatRow
                key={seat.seat}
                seat={seat}
                catalog={catalog}
                conversations={props.conversations}
                openConversationLabel={props.conversationLabels?.open}
              />
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
