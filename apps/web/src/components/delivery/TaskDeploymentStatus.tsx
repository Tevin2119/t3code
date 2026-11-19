import type { TaskDeploymentPublication } from "@t3tools/contracts";
import { RocketIcon } from "lucide-react";
import { createContext, useContext } from "react";
import { taskDeploymentLabel, taskDeploymentStatus } from "../../lib/boardDelivery";
import type { DeliveryCard } from "../../lib/delivery";
import { Badge } from "../ui/badge";
import { TaskDisclosure } from "./TaskDisclosure";

// One parent freshness clock for a whole board; cards never query or schedule work.
export const DeploymentSnapshotStale = createContext(true);

export function TaskDeploymentBadge({ card }: { card: DeliveryCard }) {
  const stale = useContext(DeploymentSnapshotStale);
  if (!card.deployment) return null;
  const current = card.deployment.current;
  const status = taskDeploymentStatus(current);
  return (
    <span
      className="block max-w-full break-words text-2xs text-muted-foreground"
      data-task-deployment={status.state}
    >
      <RocketIcon aria-hidden className="mr-1 inline size-3" />
      {stale ? "Stale snapshot · " : ""}
      {taskDeploymentLabel(card.deployment, card.run?.id ?? null)}
      {status.problem ? (
        <span className="block text-warning-foreground">{status.problem}</span>
      ) : null}
    </span>
  );
}

function Publication({
  value,
  historical,
}: {
  value: TaskDeploymentPublication;
  historical: boolean;
}) {
  const status = taskDeploymentStatus(value);
  return (
    <div className="min-w-0 space-y-2 break-words text-xs">
      <p>
        <Badge
          size="sm"
          variant={historical ? "outline" : status.state === "blocked" ? "warning" : "secondary"}
        >
          {historical ? "Historical publication" : "Attributed publication"}: {status.state}
        </Badge>
      </p>
      <p>
        {value.project?.title ?? value.projectId} ·{" "}
        {value.project?.environment ?? "unknown environment"} ·{" "}
        {value.targetBranch ?? "unknown target"}
      </p>
      <p className="break-all">
        Project: {value.projectId}
        <br />
        Original board: {value.board}
        <br />
        Repository: {value.repositoryPath ?? "unknown"}
        <br />
        Run: {value.run}
      </p>
      <p>
        Publication: {value.publicationState} · PR #{value.pullRequest.number}
      </p>
      <p className="break-all">Host-observed merge commit: {value.mergeCommit ?? "unknown"}</p>
      {status.problem ? <p className="text-warning-foreground">{status.problem}</p> : null}
      <p className="text-muted-foreground">
        Projection updated: {value.updated}. Merge and qualification are not deployment.
      </p>
      {value.candidate ? (
        <div className="space-y-1 break-all">
          <p>
            Candidate: {value.candidate.id} · {value.candidate.state}
          </p>
          <p>
            Commit: {value.candidate.commit} · Inclusion: {value.candidate.inclusion ?? "unknown"}
          </p>
          {value.candidate.failedPhase ? <p>Failed phase: {value.candidate.failedPhase}</p> : null}
          {value.candidate.liveAt ? (
            <p>
              Verified live at: {value.candidate.liveAt}
              {value.candidate.liveUntil ? ` · until ${value.candidate.liveUntil}` : ""}
            </p>
          ) : null}
          <TaskDisclosure title="Qualification evidence" defaultOpen={false}>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
              {JSON.stringify(value.candidate.evidence, null, 2) ?? "Not recorded"}
            </pre>
          </TaskDisclosure>
        </div>
      ) : (
        <p className="text-muted-foreground">No current candidate evidence.</p>
      )}
      {value.history.length ? (
        <TaskDisclosure
          title={`Historical status transitions (${value.history.length})`}
          defaultOpen={false}
        >
          <ol className="space-y-2 py-2">
            {value.history.map((entry) => (
              <li key={JSON.stringify(entry)} className="break-all">
                {entry.at} · {entry.state}
                {entry.problem ? ` · ${entry.problem}` : ""}
                {entry.candidate ? (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(entry.candidate, null, 2)}
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
        </TaskDisclosure>
      ) : null}
    </div>
  );
}

export function TaskDeploymentDetails({ card, stale }: { card: DeliveryCard; stale: boolean }) {
  const deployment = card.deployment;
  const earlier = deployment?.current.run !== card.run?.id;
  return (
    <section className="min-w-0" aria-label="Task deployment status">
      <TaskDisclosure title="Deployment" defaultOpen={!!deployment}>
        {stale ? (
          <p className="text-xs text-warning-foreground">
            Stale snapshot. This is not current deployment evidence.
          </p>
        ) : null}
        {!deployment ? (
          <p className="text-xs text-muted-foreground">
            No attributed deployment is available. A merge does not mean this task is live.
          </p>
        ) : (
          <>
            {earlier ? (
              <p className="text-xs text-warning-foreground">
                This publication belongs to an earlier run. The current run has no attributed
                deployment here.
              </p>
            ) : null}
            <Publication value={deployment.current} historical={earlier || stale} />
            {deployment.history.length ? (
              <TaskDisclosure
                title={`Earlier attributed publications (${deployment.history.length})`}
                defaultOpen={false}
              >
                <div className="space-y-4 py-2">
                  {deployment.history.map((value) => (
                    <Publication key={value.publication} value={value} historical />
                  ))}
                </div>
              </TaskDisclosure>
            ) : null}
          </>
        )}
      </TaskDisclosure>
    </section>
  );
}
