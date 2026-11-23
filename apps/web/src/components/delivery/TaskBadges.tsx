import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ClipboardListIcon, RocketIcon, UsersIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { boardLaneOf } from "../../lib/boardLanes";
import { reworkOf } from "../../lib/boardLaneCards";
import { taskDeploymentStatus } from "../../lib/boardDelivery";
import { type TaskView, waitingWords } from "../../lib/delivery";
import { harnessLabel } from "../../lib/deliverySeats";
import { cn } from "../../lib/utils";
import { useMinuteClock } from "../../state/delivery";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useBoardTask, type BoardTask } from "./BoardTaskContext";
import { ReworkCount } from "./BoardLaneCards";
import { useStageWords } from "./TaskDetails";
import { TaskTeamActivity } from "./TaskTeamActivity";
import { Age, Row } from "./taskParts";

/** The tabs of the task's own right panel, until the thread's panel hosts them. */
export type TaskPanelTab = "task-evidence" | "task-deployments";

/** A reading the engine has not answered since: shown as it was, and said to be old. */
function Stale() {
  const gt = useGT();
  return (
    <span className="shrink-0 text-warning-foreground" data-task-badge-stale>
      {gt("stale", { $context: "a reading of a board task the engine has not answered since" })}
    </span>
  );
}

function StageBadge(props: {
  readonly task: TaskView;
  readonly stale: boolean;
  readonly onOpen: () => void;
}) {
  const gt = useGT();
  const { task } = props;
  const stage = useStageWords(task);
  const rework = reworkOf(task.card);
  const needsYou = task.card.waitingOn === "person";
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      onClick={props.onOpen}
      aria-label={gt("Stage: {stage}. Opens the task's details.", { stage })}
      data-task-badge="stage"
      data-task-badge-lane={boardLaneOf(task.lane ?? "")}
      data-task-badge-needs-you={needsYou ? "" : undefined}
    >
      <span className="contents font-normal">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", needsYou ? "bg-warning" : "bg-primary/60")}
        />
        <span className="truncate">{stage}</span>
        {rework ? <ReworkCount rounds={rework.rounds} /> : null}
        {props.stale ? <Stale /> : null}
      </span>
    </Button>
  );
}

/** Who is doing what: the seat rows the engine serves, with the workers it reports. */
function TeamBadge(props: { readonly board: BoardTask; readonly task: TaskView }) {
  const gt = useGT();
  const now = useMinuteClock();
  const { board, task } = props;
  const [open, setOpen] = useState(false);
  const running = (task.council?.seats ?? []).filter((seat) => seat.activity === "active").length;
  // A seat's conversation opens in the centre, where it is read, so the list gives way to it.
  const conversations = {
    ...board.seats,
    open: (thread: ScopedThreadRef) => {
      setOpen(false);
      board.seats.open(thread);
    },
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label={gt("Team {team}. Shows who is doing what.", { team: task.team })}
            data-task-badge="team"
          />
        }
      >
        <span className="contents font-normal">
          <UsersIcon className="size-3.5 shrink-0" />
          <span className="truncate">{task.team}</span>
          {running > 0 ? (
            <span className="shrink-0 text-muted-foreground">
              {gt("{count} running", { count: running })}
            </span>
          ) : null}
          {board.stale ? <Stale /> : null}
        </span>
      </PopoverTrigger>
      <PopoverPopup align="end">
        <div
          className="-mx-2 flex max-h-96 w-80 max-w-full flex-col overflow-y-auto"
          data-task-team
        >
          <TaskTeamActivity
            environmentId={board.environmentId}
            task={task}
            conversations={conversations}
            flow={false}
          />
          {task.card.workers.length > 0 ? (
            <div className="flex flex-col gap-1.5 px-4 pb-2" data-task-workers>
              {task.card.workers.map((worker) => (
                <Row
                  key={`${worker.seat}:${worker.stage}`}
                  label={worker.waiting ? "Waiting" : "Working"}
                >
                  {worker.seat} on {harnessLabel(worker.harness)}, {worker.stage}
                  {worker.waiting ? `, ${waitingWords(worker.waiting)}` : ""}
                  {worker.waitingWhy ? (
                    <span className="block text-2xs text-muted-foreground">
                      {worker.waitingWhy}
                    </span>
                  ) : null}
                  {worker.specialist ? ` as ${worker.specialist}` : ""}{" "}
                  <Age at={worker.since} now={now} label="Since" />
                </Row>
              ))}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** A tab's door: its icon and name, with what the engine reports beside it when there is any. */
function TabBadge(props: {
  readonly tab: TaskPanelTab;
  readonly name: string;
  readonly icon: ReactNode;
  readonly onOpen: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={props.onOpen}
            data-task-badge={props.tab === "task-evidence" ? "evidence" : "deployment"}
          />
        }
      >
        <span className="contents font-normal">
          {props.icon}
          <span className="sr-only">{props.name}</span>
          {props.children}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.name}</TooltipPopup>
    </Tooltip>
  );
}

function DeploymentBadge(props: {
  readonly task: TaskView;
  readonly stale: boolean;
  readonly onOpen: () => void;
}) {
  const gt = useGT();
  const deployment = props.task.card.deployment;
  const status = deployment ? taskDeploymentStatus(deployment.current) : null;
  return (
    <TabBadge
      tab="task-deployments"
      name={gt("Deployments")}
      icon={<RocketIcon className="size-3.5 shrink-0" />}
      onOpen={props.onOpen}
    >
      {status ? (
        <span
          className={cn("truncate", status.problem && "text-warning-foreground")}
          data-task-badge-deployment={status.state}
        >
          {status.state}
        </span>
      ) : null}
      {status && props.stale ? <Stale /> : null}
    </TabBadge>
  );
}

/**
 * The task's engine facts at the top of its page, in the place a thread's team and lineup sit:
 * the stage, the team, the evidence and the deployment. Each opens where its detail is. All of it
 * is the board's read of the task; outside a board task's view there is nothing to show.
 */
export function TaskBadges(props: {
  readonly onOpenDetails: () => void;
  readonly onOpenTab: (tab: TaskPanelTab) => void;
  readonly className?: string;
}) {
  const gt = useGT();
  const board = useBoardTask();
  const task = board?.task;
  if (!board || !task) return null;
  return (
    <span className={cn("flex min-w-0 items-center gap-0.5", props.className)} data-task-badges>
      <StageBadge task={task} stale={board.stale} onOpen={props.onOpenDetails} />
      <TeamBadge board={board} task={task} />
      <TabBadge
        tab="task-evidence"
        name={gt("Task evidence")}
        icon={<ClipboardListIcon className="size-3.5 shrink-0" />}
        onOpen={() => props.onOpenTab("task-evidence")}
      />
      <DeploymentBadge
        task={task}
        stale={board.stale}
        onOpen={() => props.onOpenTab("task-deployments")}
      />
    </span>
  );
}
