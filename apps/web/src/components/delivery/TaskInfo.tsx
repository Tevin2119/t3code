import type { EnvironmentId } from "@t3tools/contracts";
import { PencilIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useNavigate } from "@tanstack/react-router";

import {
  parseTarget,
  seatSettingsToSend,
  TASK_PRIORITIES,
  targetLine,
  type TaskPriority,
  type TaskView,
  waitingWords,
} from "../../lib/delivery";
import { ageLabel, LANE_TITLE, PRIORITY_LABEL, tagsFromText } from "../../lib/deliveryBoard";
import { boardLaneOf } from "../../lib/boardLanes";
import type { MoveBoard } from "../../lib/deliveryMove";
import { seatsChangedForTask, harnessLabel } from "../../lib/deliverySeats";
import { cn } from "../../lib/utils";
import {
  useBoardStore,
  useDeliveryAct,
  useDeliveryRead,
  useMinuteClock,
  usePersonName,
  withSeatChoice,
} from "../../state/delivery";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SeatSettingsPanel } from "./SeatSettingsPanel";
import {
  Age,
  laneTone,
  PriorityPill,
  PublicationRows,
  QaVotes,
  Row,
  TagList,
  time,
  WaitingOn,
} from "./taskParts";
import { TaskDisclosure } from "./TaskDisclosure";
import { MergePermissionControls } from "./MergePermissionControls";
import { RunPanel } from "./RunPanel";

export function Info(props: {
  readonly environmentId: EnvironmentId | null;
  readonly from: "Board" | "Orchestrator";
  readonly task: TaskView;
  readonly onChanged: () => void;
  readonly stale: boolean;
}) {
  const { task } = props;
  const { card } = task;
  const person = usePersonName();
  const name = useBoardStore((state) => state.person);
  const setPerson = useBoardStore((state) => state.setPerson);
  const now = useMinuteClock();
  const act = useDeliveryAct(props.environmentId, "task edit");
  const [tags, setTags] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);
  const closed = ["approved", "rejected", "closed"].includes(task.state);
  const flow = task.flows.find((item) => item.id === task.workflow) ?? null;
  const navigate = useNavigate();
  // The boards of the person's own, to name the one the task is on.
  const boardsRead = useDeliveryRead(props.environmentId, "/api/boards");
  const boards: ReadonlyArray<MoveBoard> = (
    Array.isArray(boardsRead.body) ? boardsRead.body : []
  ).flatMap((item: unknown) =>
    item && typeof item === "object" && "id" in item && "title" in item
      ? [
          {
            id: String(item.id),
            title: String(item.title),
            target: "target" in item ? parseTarget(item.target) : null,
          },
        ]
      : [],
  );
  // The board triage thinks the task belongs on. Moving it there is in the header's menu.
  const suggested = task.suggestedBoard ?? card.suggestedBoard ?? null;
  // What is set for the task, which the switches change.
  const set = Object.fromEntries(task.settings.map((item) => [item.seat, item.set]));
  // The seat choices last sent. Until a read of the task shows it changed since (its last
  // change is later), a second switch builds on the first, instead of on a read from before
  // it, a poll included, which would undo it.
  const sentSeats = useRef<{ readonly updated: string; readonly set: typeof set } | null>(null);
  const switchSeat = async (seat: string, choice: Record<string, string>) => {
    setProblems([]);
    const pending = sentSeats.current && task.updated <= sentSeats.current.updated;
    const base = pending && sentSeats.current ? sentSeats.current.set : set;
    const next = withSeatChoice(base, seat, choice);
    sentSeats.current = {
      updated: pending && sentSeats.current ? sentSeats.current.updated : task.updated,
      set: next,
    };
    const result = await act(`/api/tasks/${task.id}/edit`, {
      seats: seatSettingsToSend(task.settings, next),
      by: person,
    });
    if (!result.ok) setProblems(result.problems.length > 0 ? result.problems : [result.why]);
    props.onChanged();
  };

  const edit = async (patch: Record<string, unknown>) => {
    setProblem(null);
    const result = await act(`/api/tasks/${task.id}/edit`, { ...patch, by: person });
    if (!result.ok) setProblem(result.why);
    props.onChanged();
  };

  return (
    <aside
      className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto p-4"
      data-task-info
      aria-label="About this task"
    >
      <section className="flex flex-col gap-1.5">
        <TaskDisclosure title="Status and decisions">
          <Row label="Stands in">
            <span className="inline-flex items-center gap-1.5" data-task-lane={task.lane ?? ""}>
              <span className={cn("size-2 rounded-full", laneTone(task.lane).bar)} />
              {LANE_TITLE[boardLaneOf(task.lane ?? "")] ?? task.state}
            </span>
          </Row>
          {card.set === "qualification" ? (
            <Row label="Kept as">
              <span data-task-set="qualification">
                the qualification's evidence, not pilot work
              </span>
            </Row>
          ) : (
            <Row label="Board">
              {/* A board other than the suggested one is outlined in the warning tone. */}
              <span
                className={cn(
                  "inline-flex min-w-0 rounded-md",
                  suggested && suggested.id !== card.set && "px-1 ring-1 ring-warning/60",
                )}
                data-task-board={card.set ?? ""}
              >
                {boards.find((item) => item.id === card.set)?.title ??
                  (card.set ? card.set : "Not on a board")}
              </span>
            </Row>
          )}
          <Row label="Now">
            <WaitingOn card={card} />
          </Row>
          {card.blocker ? (
            <p
              className={cn(
                "rounded border px-2 py-1 text-xs",
                card.waitingOn === "person"
                  ? "border-warning/60 bg-warning/5"
                  : "border-border text-muted-foreground",
              )}
              data-task-blocker
            >
              {card.blocker}
            </p>
          ) : null}
          {card.workers.map((worker) => (
            <Row
              key={`${worker.seat}:${worker.stage}`}
              label={worker.waiting ? "Waiting" : "Working"}
            >
              {worker.seat} on {harnessLabel(worker.harness)}, {worker.stage}
              {worker.waiting ? `, ${waitingWords(worker.waiting)}` : ""}
              {worker.waitingWhy ? (
                <span className="block text-2xs text-muted-foreground">{worker.waitingWhy}</span>
              ) : null}
              {worker.specialist ? ` as ${worker.specialist}` : ""}{" "}
              <Age at={worker.since} now={now} label="Since" />
            </Row>
          ))}
          {card.qa && card.qa.votes.length > 0 ? (
            <Row label="QA">
              <QaVotes qa={card.qa} />
            </Row>
          ) : null}
          {card.findings.all > 0 ? (
            <Row label="Findings">
              {card.findings.open} open of {card.findings.all}
            </Row>
          ) : null}
          {card.approvals.map((approval) => (
            <Row key={`${approval.actor}:${approval.decision}:${approval.stands}`} label="Decision">
              <span
                className="flex flex-col items-end"
                data-task-approval-verified={approval.verifiedAt ?? ""}
              >
                <span>
                  {approval.decision} by {approval.actor},{" "}
                  {approval.stands ? "stands" : "no longer stands"}
                </span>
                {approval.verifiedAt ? (
                  <span className="text-3xs text-muted-foreground">
                    checked{" "}
                    {ageLabel(approval.verifiedAt, now) === "now" ||
                    !ageLabel(approval.verifiedAt, now)
                      ? "just now"
                      : `${ageLabel(approval.verifiedAt, now)} ago`}
                    ; proved again before anything is published
                  </span>
                ) : null}
              </span>
            </Row>
          ))}
        </TaskDisclosure>
      </section>

      <section className="flex flex-col gap-1.5">
        <TaskDisclosure title="Ownership and repository">
          <Row label="Priority">
            {closed ? (
              <PriorityPill priority={task.priority} by={task.priorityBy} />
            ) : (
              <Select
                value={task.priority}
                onValueChange={(value) => void edit({ priority: value as TaskPriority })}
              >
                <SelectTrigger
                  aria-label="Priority"
                  size="compact"
                  variant="ghost"
                  className="ml-auto w-auto min-w-0"
                >
                  <SelectValue>
                    <PriorityPill priority={task.priority} />
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {TASK_PRIORITIES.map((priority) => (
                    <SelectItem key={priority} value={priority}>
                      {PRIORITY_LABEL[priority]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </Row>
          {/* Where its work is done. A task keeps it; moving it to another board does not change it. */}
          <Row label="Repository">
            <span
              className="flex min-w-0 flex-col"
              data-task-target={task.target?.ok ? "ok" : "none"}
            >
              <span className={task.target?.ok ? "" : "text-warning"}>
                {targetLine(task.target)}
              </span>
              {task.target?.ok && task.target.path ? (
                <span className="truncate font-mono text-2xs text-muted-foreground">
                  {task.target.path}
                </span>
              ) : null}
            </span>
          </Row>
          <Row label="Team">{task.team}</Row>
          <Row label="Flow">
            <span data-task-flow={task.workflow}>{flow?.title ?? task.workflow}</span>
          </Row>
          <Row label="Owner">{task.owner || "nobody"}</Row>
          <Row label="Tags">
            {tags === null ? (
              <span className="inline-flex flex-wrap items-center justify-end gap-1">
                <TagList tags={task.tags} />
                {closed ? null : (
                  <button
                    type="button"
                    aria-label="Change the tags"
                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                    onClick={() => setTags(task.tags.join(", "))}
                  >
                    <PencilIcon className="size-3" />
                  </button>
                )}
              </span>
            ) : (
              <Input
                aria-label="Tags"
                size="compact"
                className="w-44"
                autoFocus
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                onBlur={() => {
                  void edit({ tags: tagsFromText(tags) });
                  setTags(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setTags(null);
                }}
              />
            )}
          </Row>
          {task.deadline ? <Row label="Wanted by">{task.deadline.slice(0, 10)}</Row> : null}
          <Row label="Created">{time(task.created)}</Row>
          {task.submitted ? <Row label="Submitted">{time(task.submitted)}</Row> : null}
          <Row label="Last changed">{time(task.updated)}</Row>
          <Row label="Id">
            <span className="font-mono text-3xs">{task.id}</span>
          </Row>
          {problem ? <p className="text-xs text-warning">{problem}</p> : null}
        </TaskDisclosure>
      </section>

      {card.run ? (
        <section className="flex flex-col gap-1.5">
          <TaskDisclosure title="Run and evidence" defaultOpen={false}>
            <Row label="Run">
              <span className="font-mono text-3xs">{card.run.id}</span>
            </Row>
            <Row label="State">
              {card.run.state} at {card.run.stage}
            </Row>
            {card.run.candidate ? (
              <Row label="Candidate">
                <span className="font-mono text-3xs">{card.run.candidate.slice(0, 12)}</span>
              </Row>
            ) : null}
            <Row label="Setup">
              <span className="font-mono text-3xs">{card.run.configuration}</span>
            </Row>
            {task.council?.evidence ? (
              <Row label="Evidence">
                <span className="font-mono text-3xs break-all">{task.council.evidence}</span>
              </Row>
            ) : null}
            {task.children.length > 1 ? (
              <Row label="Runs">{task.children.length} for this task</Row>
            ) : null}
          </TaskDisclosure>
        </section>
      ) : null}

      {props.environmentId ? (
        <TaskDisclosure title="Automatic merge permission" defaultOpen={false}>
          <MergePermissionControls
            environmentId={props.environmentId}
            path={`/api/tasks/${task.id}/merge-permission`}
            policy={card.mergePermission}
            stale={props.stale}
            onDone={props.onChanged}
          />
        </TaskDisclosure>
      ) : null}

      <section className="flex flex-col gap-1.5" data-task-related>
        <TaskDisclosure title="Linked conversations" defaultOpen={false}>
          <p className="text-2xs text-muted-foreground">
            What is said on this task is its conversation with the team. A thread in the chat list
            is a conversation of its own; it becomes a task only when you create one from it.
          </p>
          {task.source ? (
            <Row label="Made from">
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                data-task-related-source
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: {
                      environmentId: task.source!.environmentId,
                      threadId: task.source!.threadId,
                    },
                  })
                }
              >
                the conversation it came from
              </button>
            </Row>
          ) : null}
          {card.run ? (
            <Row label="Run">
              <span className="font-mono text-3xs" data-task-related-run>
                {card.run.id}
                {card.run.candidate ? ` · commit ${card.run.candidate.slice(0, 10)}` : ""}
              </span>
            </Row>
          ) : null}
          {card.waitingOn ? (
            <Row label="Waiting on you">
              <span data-task-related-waiting>yes: {card.waitingOn}</span>
            </Row>
          ) : null}
          <PublicationRows task={task} />
        </TaskDisclosure>
      </section>

      {closed ? null : (
        <section className="flex flex-col gap-1.5" data-task-seats>
          <TaskDisclosure title="Seat settings" defaultOpen={false}>
            <SeatSettingsPanel
              environmentId={props.environmentId}
              settings={task.settings.map((item) => ({ ...item, now: item.effective }))}
              chosen={{}}
              taking={flow?.seats}
              switchesOnly
              onChange={(seat, choice) =>
                void switchSeat(seat, {
                  ...set[seat],
                  active: choice.active === "" || choice.active === undefined ? "" : choice.active,
                })
              }
            />
            {seatsChangedForTask(task.settings).length > 0 ? (
              <div
                className="rounded border border-border bg-muted/40 px-2 py-1.5 text-2xs"
                data-task-seats-changed
              >
                <p className="font-medium">
                  Changed for this task only. The team's own setting is as it was.
                </p>
                <ul className="list-disc pl-4 text-muted-foreground">
                  {seatsChangedForTask(task.settings).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {problems.length > 0 ? (
              <ul className="list-disc pl-5 text-2xs text-warning" data-delivery-problem>
                {problems.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            <p className="text-2xs text-muted-foreground">
              {task.workflow === "chat"
                ? "A change counts from the next message on."
                : "A run keeps the seats it started with. A change counts for the next run. A seat that is working when it is switched off is asked to stop."}
            </p>
          </TaskDisclosure>
        </section>
      )}

      <TaskDisclosure title="Execution and checkpoints" defaultOpen={false}>
        <RunPanel
          key={task.id}
          environmentId={props.environmentId}
          task={task}
          onChanged={props.onChanged}
        />
      </TaskDisclosure>

      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium text-muted-foreground">Your name</h3>
        <Input
          aria-label="Your name"
          placeholder="Written on what you do here"
          size="compact"
          value={name}
          onChange={(event) => setPerson(event.target.value)}
        />
      </section>
    </aside>
  );
}
