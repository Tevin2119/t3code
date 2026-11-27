import type { TaskDeploymentPublication } from "@t3tools/contracts";
import { ArrowUpRightIcon, RocketIcon } from "lucide-react";
import { createContext, useContext, type MouseEvent } from "react";
import { useOpenLink } from "../../browser/useOpenLink";
import { taskDeploymentLabel, taskDeploymentStatus } from "../../lib/boardDelivery";
import type { DeliveryCard } from "../../lib/delivery";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { RelativeTime } from "../RelativeTime";
import { Badge } from "../ui/badge";
import { taskInstancesSummary } from "./ReleaseLine.logic";
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

/** Everything the engine recorded for one publication, flat: the row's one disclosure holds it. */
function PublicationDetails({
  value,
  historical,
}: {
  value: TaskDeploymentPublication;
  historical: boolean;
}) {
  const status = taskDeploymentStatus(value);
  return (
    <div className="min-w-0 space-y-2 break-words text-xs" data-task-deployment-publication>
      <p className="font-medium">
        {historical ? "Historical publication" : "Attributed publication"}: {status.state}
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
      <p className="text-muted-foreground">Projection updated: {value.updated}.</p>
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
          <p className="font-medium">Qualification evidence</p>
          <pre className="whitespace-pre-wrap break-all">
            {JSON.stringify(value.candidate.evidence, null, 2) ?? "Not recorded"}
          </pre>
        </div>
      ) : (
        <p className="text-muted-foreground">No current candidate evidence.</p>
      )}
      {value.history.length ? (
        <div className="space-y-1">
          <p className="font-medium">Historical status transitions ({value.history.length})</p>
          <ol className="space-y-2">
            {value.history.map((entry) => (
              <li key={JSON.stringify(entry)} className="break-all">
                {entry.at} · {entry.state}
                {entry.problem ? ` · ${entry.problem}` : ""}
                {entry.candidate ? (
                  <pre className="whitespace-pre-wrap break-all">
                    {JSON.stringify(entry.candidate, null, 2)}
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

const INSTANCE_BADGE = { live: "success", waiting: "info", absent: "outline" } as const;
const INSTANCE_LABEL = { live: "Live", waiting: "Waiting", absent: "Not there" } as const;

/** The task on each instance of its repository, in release-line order: "Live on qa, not on app". */
function TaskInstances({
  instances,
  historical,
}: {
  instances: TaskDeploymentPublication["instances"];
  historical: boolean;
}) {
  const summary = taskInstancesSummary(instances);
  if (!instances?.length || !summary) return null;
  return (
    <div className="space-y-1.5 border-b px-3 py-2" data-task-deployment-instances>
      <p className="text-sm font-medium">
        {historical ? "Last known: " : ""}
        {summary}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {instances.map((entry) => (
          <li key={entry.projectId} data-task-instance={entry.state}>
            <Badge size="sm" variant={historical ? "outline" : INSTANCE_BADGE[entry.state]}>
              {entry.environment} · {INSTANCE_LABEL[entry.state]}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

const LINK_CLASS =
  "inline-flex shrink-0 items-center gap-0.5 text-primary underline-offset-2 hover:underline";

/** One environment's newest publication, laid out like a linked pull request's row. */
function EnvironmentRow({
  environment,
  latest,
  older,
  historical,
}: {
  environment: string;
  latest: TaskDeploymentPublication;
  older: readonly TaskDeploymentPublication[];
  historical: boolean;
}) {
  const openPrLink = useOpenPrLink();
  const openLink = useOpenLink(null);
  const status = taskDeploymentStatus(latest);
  const external = (url: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button > 1) return;
    event.preventDefault();
    void openLink(url, { event }).catch((error: unknown) => console.error(error));
  };
  return (
    <li
      className="flex min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-accent/60"
      data-task-deployment-environment={environment}
      data-task-deployment={status.state}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Badge
          size="sm"
          variant={historical ? "outline" : status.state === "blocked" ? "warning" : "secondary"}
        >
          {status.state}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{environment}</span>
        <span className="shrink-0 text-2xs text-muted-foreground">
          <RelativeTime timestamp={latest.updated} />
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {latest.project?.title ?? latest.projectId} · {latest.targetBranch ?? "unknown target"}
        </span>
        <a
          href={latest.pullRequest.url}
          onClick={(event) => openPrLink(event, latest.pullRequest.url)}
          className={LINK_CLASS}
        >
          PR #{latest.pullRequest.number}
          <ArrowUpRightIcon aria-hidden className="size-3" />
        </a>
        {latest.previewUrl ? (
          <a href={latest.previewUrl} onClick={external(latest.previewUrl)} className={LINK_CLASS}>
            Preview
            <ArrowUpRightIcon aria-hidden className="size-3" />
          </a>
        ) : null}
        {latest.logsUrl ? (
          <a href={latest.logsUrl} onClick={external(latest.logsUrl)} className={LINK_CLASS}>
            Logs
            <ArrowUpRightIcon aria-hidden className="size-3" />
          </a>
        ) : null}
        {latest.deploymentId ? (
          <span className="font-mono text-3xs break-all">Deployment {latest.deploymentId}</span>
        ) : null}
      </div>
      {status.problem ? <p className="text-xs text-warning-foreground">{status.problem}</p> : null}
      <TaskDisclosure title="Details" defaultOpen={false}>
        <PublicationDetails value={latest} historical={historical} />
        {older.map((value) => (
          <PublicationDetails key={value.publication} value={value} historical />
        ))}
      </TaskDisclosure>
    </li>
  );
}

/**
 * A board task's deployment status as a right-panel tab: one row per environment, newest
 * publication first, with everything the engine recorded one disclosure down.
 */
export function TaskDeploymentsPanel({ card, stale }: { card: DeliveryCard; stale: boolean }) {
  const deployment = card.deployment;
  const staleNotice = stale ? (
    <p className="text-xs text-warning-foreground">
      Stale snapshot. This is not current deployment evidence.
    </p>
  ) : null;
  if (!deployment) {
    return (
      <section
        className="flex w-full flex-col items-center justify-center gap-2 p-6 text-center"
        aria-label="Task deployment status"
      >
        <RocketIcon aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No deployment yet</p>
        <p className="max-w-60 text-xs text-muted-foreground">
          No attributed deployment is available. A merge does not mean this task is live.
        </p>
        {staleNotice}
      </section>
    );
  }
  const earlier = deployment.current.run !== card.run?.id;
  const rows = new Map<
    string,
    { latest: TaskDeploymentPublication; older: TaskDeploymentPublication[] }
  >();
  // The current publication comes first, so it is its environment's row.
  for (const value of [deployment.current, ...deployment.history]) {
    const environment = value.project?.environment ?? "unknown environment";
    const row = rows.get(environment);
    if (row) row.older.push(value);
    else rows.set(environment, { latest: value, older: [] });
  }
  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Task deployment status">
      {staleNotice || earlier ? (
        <div className="space-y-1 border-b px-3 py-2">
          {staleNotice}
          {earlier ? (
            <p className="text-xs text-warning-foreground">
              This publication belongs to an earlier run. The current run has no attributed
              deployment here.
            </p>
          ) : null}
        </div>
      ) : null}
      <TaskInstances instances={deployment.current.instances} historical={stale || earlier} />
      <ul className="flex min-w-0 flex-col p-1.5">
        {[...rows].map(([environment, row]) => (
          <EnvironmentRow
            key={environment}
            environment={environment}
            latest={row.latest}
            older={row.older}
            historical={stale || earlier || row.latest !== deployment.current}
          />
        ))}
      </ul>
      <footer className="mt-auto border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
        {rows.size === 1 ? "1 environment" : `${rows.size} environments`}. Merge and qualification
        are not deployment.
      </footer>
    </section>
  );
}
