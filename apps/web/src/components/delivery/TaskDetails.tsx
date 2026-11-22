import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import type { TaskBrief, TaskView } from "../../lib/delivery";
import { LANE_TITLE } from "../../lib/deliveryBoard";
import { boardLaneOf } from "../../lib/boardLanes";
import { harnessLabel } from "../../lib/deliverySeats";
import { cn } from "../../lib/utils";
import { TaskFileList } from "./taskFiles";
import { laneTone, time } from "./taskParts";
import { TaskDisclosure } from "./TaskDisclosure";
import { relatedTaskGroups } from "./relatedTaskGroups";

function Listed(props: {
  readonly title: string;
  readonly items: ReadonlyArray<string>;
  /** A name a line of the history can point at; see sectionOf. */
  readonly section?: string;
}) {
  if (props.items.length === 0) return null;
  return (
    <section data-task-section={props.section}>
      <h3 className="pb-1 text-xs font-medium text-muted-foreground">{props.title}</h3>
      <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm">
        {props.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function Briefs(props: {
  readonly title: string;
  readonly tasks: ReadonlyArray<
    TaskBrief & { readonly kind?: string; readonly direction?: string }
  >;
  readonly onOpen: (id: string) => void;
}) {
  if (props.tasks.length === 0) return null;
  return (
    <section>
      <h3 className="pb-1 text-xs font-medium text-muted-foreground">{props.title}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {props.tasks.map((item) => (
          <li key={`${item.id}:${item.kind ?? ""}:${item.direction ?? ""}`}>
            <button
              type="button"
              onClick={() => props.onOpen(item.id)}
              className="flex w-full cursor-pointer items-start gap-2 rounded px-1 py-1.5 text-left hover:bg-accent"
            >
              <span className={cn("size-2 shrink-0 rounded-full", laneTone(item.lane).bar)} />
              <span className="font-mono text-xs text-muted-foreground">#{item.number}</span>
              <span className="min-w-0 flex-1 break-words">{item.title}</span>
              <span className="max-w-28 shrink-0 text-right text-xs text-muted-foreground">
                {item.kind === "depends-on"
                  ? item.direction === "out"
                    ? "this waits for it"
                    : "it waits for this"
                  : ""}{" "}
                {LANE_TITLE[boardLaneOf(item.lane ?? "")] ?? item.state}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Details(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: TaskView;
  readonly onOpenTask: (id: string) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { task } = props;
  const [showRevisions, setShowRevisions] = useState(false);
  const parts = relatedTaskGroups(task.card.parts);
  const followUps = relatedTaskGroups(task.followUps);
  const hasRelated =
    task.parent || task.card.parts.length || task.links.length || task.followUps.length;
  return (
    <section className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto p-4" data-task-details>
      {hasRelated ? (
        <section className="rounded-lg border border-border p-3" data-task-related-work>
          <TaskDisclosure
            title={`Related work (${parts.current.length} current parts, ${followUps.current.length} QA follow-ups)`}
          >
            {task.card.blocker ? (
              <p className="text-sm text-muted-foreground">{task.card.blocker}</p>
            ) : null}
            {task.parent ? (
              <Briefs title="Parent task" tasks={[task.parent]} onOpen={props.onOpenTask} />
            ) : null}
            <Briefs
              title={`Current parts (${parts.current.length})`}
              tasks={parts.current}
              onOpen={props.onOpenTask}
            />
            <Briefs
              title={`QA follow-ups (${followUps.current.length})`}
              tasks={followUps.current}
              onOpen={props.onOpenTask}
            />
            <Briefs
              title="Dependencies and related tasks"
              tasks={task.links}
              onOpen={props.onOpenTask}
            />
            {parts.completed.length + followUps.completed.length > 0 ? (
              <TaskDisclosure
                title={`Completed related work (${parts.completed.length + followUps.completed.length})`}
                defaultOpen={false}
              >
                <Briefs title="Completed parts" tasks={parts.completed} onOpen={props.onOpenTask} />
                <Briefs
                  title="Completed QA follow-ups"
                  tasks={followUps.completed}
                  onOpen={props.onOpenTask}
                />
              </TaskDisclosure>
            ) : null}
            {parts.historical.length + followUps.historical.length > 0 ? (
              <TaskDisclosure
                title={`Previous or closed work (${parts.historical.length + followUps.historical.length})`}
                defaultOpen={false}
              >
                <p className="text-xs text-muted-foreground">
                  Kept for history. Rejected or closed parts are not proof of delivery.
                </p>
                <Briefs title="Previous parts" tasks={parts.historical} onOpen={props.onOpenTask} />
                <Briefs
                  title="Closed QA follow-ups"
                  tasks={followUps.historical}
                  onOpen={props.onOpenTask}
                />
              </TaskDisclosure>
            ) : null}
          </TaskDisclosure>
        </section>
      ) : null}
      <TaskDisclosure title="Task details" open={props.open} onOpenChange={props.onOpenChange}>
        <section>
          <h3 className="pb-1 text-xs font-medium text-muted-foreground">
            What is asked, revision {task.revision}
          </h3>
          <p className="text-sm break-words whitespace-pre-wrap">{task.body}</p>
        </section>
        {task.plan ? (
          <section
            className="flex flex-col gap-2 rounded-md border border-border p-2"
            data-task-plan
            data-task-section="plan"
          >
            <h3 className="text-xs font-medium">
              The plan{task.plan.agreed ? ", agreed and being delivered" : ", for you to read"}
            </h3>
            <p className="text-sm break-words whitespace-pre-wrap">{task.plan.approach}</p>
            <Listed title="Steps" items={task.plan.steps} />
            <Listed title="Checks" items={task.plan.checks} />
            <Listed title="What it does not cover" items={task.plan.limits} />
            {task.plan.comments.map((comment) => (
              <p key={comment.seat} className="text-xs text-muted-foreground">
                {comment.seat}: {comment.stance}
                {comment.points.length > 0 ? `. ${comment.points.join(" ")}` : ""}
              </p>
            ))}
            <p className="font-mono text-3xs break-all text-muted-foreground">{task.plan.file}</p>
          </section>
        ) : null}
        {task.review ? (
          <section
            className="flex flex-col gap-2 rounded-md border border-border p-2"
            data-task-review
          >
            <h3 className="text-xs font-medium">What the review found</h3>
            {task.review.seats.map((seat) => (
              <div
                key={seat.seat}
                className="flex flex-col gap-1 text-sm"
                data-review-seat={seat.seat}
              >
                <p className="text-xs font-medium">
                  {seat.seat} on {harnessLabel(seat.harness)}
                </p>
                <p className="break-words whitespace-pre-wrap">{seat.summary}</p>
                {seat.findings.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No findings.</p>
                ) : (
                  <ul className="flex list-disc flex-col gap-0.5 pl-5 text-xs">
                    {seat.findings.map((finding) => (
                      <li key={`${finding.title}:${finding.where}`}>
                        {finding.blocking ? <span className="text-warning">Blocking. </span> : null}
                        {finding.title}{" "}
                        <span className="font-mono text-3xs text-muted-foreground">
                          {finding.where}
                        </span>
                        <span className="block text-muted-foreground">{finding.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {task.review.missing.length > 0 ? (
              <p className="text-xs text-warning">
                No answer from {task.review.missing.join(", ")}.
              </p>
            ) : null}
            <p className="font-mono text-3xs break-all text-muted-foreground">{task.review.file}</p>
          </section>
        ) : null}
        <Listed title="Requirements" items={task.requirements} />
        <Listed title="Acceptance criteria" items={task.acceptance} section="acceptance" />
        {task.files.length > 0 ? (
          <section>
            <h3 className="pb-1 text-xs font-medium text-muted-foreground">
              Files ({task.files.length})
            </h3>
            <TaskFileList environmentId={props.environmentId} files={task.files} />
          </section>
        ) : null}
        {task.revisions.length > 1 ? (
          <section>
            <button
              type="button"
              className="cursor-pointer pb-1 text-xs font-medium text-muted-foreground underline"
              aria-expanded={showRevisions}
              onClick={() => setShowRevisions((current) => !current)}
            >
              {showRevisions ? "Hide" : "Show"} the {task.revisions.length} revisions
            </button>
            {showRevisions ? (
              <ul className="flex flex-col gap-2">
                {task.revisions.toReversed().map((revision) => (
                  <li key={revision.revision} className="rounded border border-border p-2 text-xs">
                    <p className="font-mono text-3xs text-muted-foreground">
                      r{revision.revision}, {time(revision.created)}
                      {revision.notes ? `, ${revision.notes}` : ""}
                    </p>
                    <p className="break-words whitespace-pre-wrap">{revision.body}</p>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </TaskDisclosure>
    </section>
  );
}
