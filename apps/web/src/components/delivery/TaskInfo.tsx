import type { EnvironmentId } from "@t3tools/contracts";

import type { TaskView } from "../../lib/delivery";
import { ageLabel } from "../../lib/deliveryBoard";
import { harnessLabel } from "../../lib/deliverySeats";
import { useMinuteClock } from "../../state/delivery";
import { PublicationRows, QaVotes, Row } from "./taskParts";
import { TaskDisclosure } from "./TaskDisclosure";
import { MergePermissionControls } from "./MergePermissionControls";
import { RunPanel } from "./RunPanel";

/**
 * The Evidence tab's body: what the run proved and what was decided on it. The task's own words,
 * ownership and seats are in the Task item of the details, and its stage and team in the badges.
 */
export function Info(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: TaskView;
  readonly onChanged: () => void;
  readonly stale: boolean;
}) {
  const { task } = props;
  const { card } = task;
  const now = useMinuteClock();
  const decided = (card.qa && card.qa.votes.length > 0) || card.findings.all > 0;

  return (
    <aside
      className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto p-4"
      data-task-info
      aria-label="About this task"
    >
      {decided || card.approvals.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <TaskDisclosure title="Status and decisions">
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
              <Row
                key={`${approval.actor}:${approval.decision}:${approval.stands}`}
                label="Decision"
              >
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
            <p className="text-xs text-warning">No answer from {task.review.missing.join(", ")}.</p>
          ) : null}
          <p className="font-mono text-3xs break-all text-muted-foreground">{task.review.file}</p>
        </section>
      ) : null}

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

      <TaskDisclosure title="Execution and checkpoints" defaultOpen={false}>
        <RunPanel
          key={task.id}
          environmentId={props.environmentId}
          task={task}
          onChanged={props.onChanged}
        />
      </TaskDisclosure>
    </aside>
  );
}
