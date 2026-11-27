import { projectCommitUrl } from "@t3tools/client-runtime/change-request-links";
import type {
  DeploymentCompare,
  DeploymentComparePullRequest,
  DeploymentCompareRange,
  DeploymentCompareTask,
  DeploymentProject,
  DeploymentPromotion,
  EnvironmentId,
  RepositoryIdentity,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpRightIcon, FolderIcon, SquareKanbanIcon } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";
import { useOpenLink } from "../../browser/useOpenLink";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { useDeliveryRead, useStaleReading } from "../../state/delivery";
import { Badge } from "../ui/badge";
import type { DeploymentRequest } from "./DeploymentInstance";
import { PortDialog, PortSlot } from "./ReleaseLine.port";
import { PromotionControls } from "./ReleaseLine.promote";
import type { SyncCheckout } from "./ReleaseLine.sync";
import {
  comparePath,
  parseDeploymentCompare,
  portRowsOf,
  pullRequestUrl,
  shownRows,
} from "./ReleaseLine.logic";

const ROW = "flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs";
const KIND = { feature: "info", fix: "warning", other: "outline" } as const;
const KIND_LABEL = { feature: "Feature", fix: "Fix", other: "Other" } as const;

function useOpenTask(environmentId: EnvironmentId) {
  const navigate = useNavigate();
  return (task: string) =>
    void navigate({ to: "/board", search: { environment: environmentId, task } });
}

function PullRequestRow({
  pr,
  identity,
  onTask,
  extra,
}: {
  pr: DeploymentComparePullRequest;
  identity: RepositoryIdentity | null;
  onTask: (task: string) => void;
  extra: ReactNode;
}) {
  const openPrLink = useOpenPrLink();
  const url = pullRequestUrl(pr, identity);
  const label = `${pr.number === null ? "PR" : `#${pr.number}`} ${pr.title}`;
  return (
    <li className={`${ROW} hover:bg-accent/60`} data-release-row="pr">
      <Badge size="sm" variant={KIND[pr.kind]}>
        {KIND_LABEL[pr.kind]}
      </Badge>
      {url ? (
        <a
          href={url}
          onClick={(event) => openPrLink(event, url)}
          className="min-w-0 flex-1 break-words text-foreground underline-offset-2 hover:underline"
        >
          {label}
        </a>
      ) : (
        <span className="min-w-0 flex-1 break-words">{label}</span>
      )}
      {pr.task ? (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 text-primary underline-offset-2 hover:underline"
          onClick={() => onTask(pr.task!)}
        >
          <SquareKanbanIcon aria-hidden className="size-3" />
          Task
        </button>
      ) : null}
      {extra}
    </li>
  );
}

function CommitRow({
  commit,
  subject,
  identity,
  extra,
}: {
  commit: string;
  subject: string;
  identity: RepositoryIdentity | null;
  extra: ReactNode;
}) {
  const openLink = useOpenLink(null);
  const url = projectCommitUrl(identity, commit);
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!url || event.button > 1) return;
    event.preventDefault();
    void openLink(url, { event }).catch((error: unknown) => console.error(error));
  };
  return (
    <li className={ROW} data-release-row="commit">
      <code className="shrink-0 font-mono text-3xs text-muted-foreground">
        {commit.slice(0, 7)}
      </code>
      <span className="min-w-0 flex-1 break-words">{subject}</span>
      {url ? (
        <a
          href={url}
          onClick={open}
          aria-label={`Open commit ${commit.slice(0, 7)}`}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ArrowUpRightIcon aria-hidden className="size-3" />
        </a>
      ) : null}
      {extra}
    </li>
  );
}

function TaskRow({ task, onTask }: { task: DeploymentCompareTask; onTask: (id: string) => void }) {
  return (
    <li className="min-w-0" data-release-row="task">
      <button
        type="button"
        className={`${ROW} w-full text-left hover:bg-accent/60`}
        onClick={() => onTask(task.id)}
      >
        <SquareKanbanIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 break-words">
          {task.number === null ? "" : `#${task.number} `}
          {task.title}
        </span>
        {task.state ? (
          <span className="shrink-0 text-2xs text-muted-foreground">{task.state}</span>
        ) : null}
      </button>
    </li>
  );
}

/** PRs, then loose commits, then tasks, each capped so a long range stays one glance. */
function RangeSection({
  title,
  range,
  limit,
  identity,
  onTask,
  rowExtra = () => null,
}: {
  title: string;
  range: DeploymentCompareRange;
  limit: number;
  identity: RepositoryIdentity | null;
  onTask: (task: string) => void;
  /** What a commit's row adds at its end: Port to app, on the ahead range. */
  rowExtra?: (commit: string) => ReactNode;
}) {
  const prs = shownRows(range.prs);
  const loose = shownRows(range.loose);
  const tasks = shownRows(range.tasks);
  const hidden = prs.hidden + loose.hidden + tasks.hidden;
  return (
    <section className="min-w-0" aria-label={title}>
      <h4 className="flex items-baseline gap-2 px-2 text-xs font-medium">
        <span className="min-w-0 flex-1">{title}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {range.count === 1 ? "1 commit" : `${range.count} commits`}
          {range.truncated ? `, first ${limit} read` : ""}
        </span>
      </h4>
      {range.count === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">Nothing.</p>
      ) : (
        <ul className="mt-1 flex min-w-0 flex-col">
          {prs.rows.map((pr) => (
            <PullRequestRow
              key={pr.commit}
              pr={pr}
              identity={identity}
              onTask={onTask}
              extra={rowExtra(pr.commit)}
            />
          ))}
          {loose.rows.map((row) => (
            <CommitRow
              key={row.commit}
              commit={row.commit}
              subject={row.subject}
              identity={identity}
              extra={rowExtra(row.commit)}
            />
          ))}
          {tasks.rows.map((task) => (
            <TaskRow key={task.id} task={task} onTask={onTask} />
          ))}
        </ul>
      )}
      {hidden > 0 ? (
        <p className="px-2 pt-1 text-2xs text-muted-foreground">{hidden} more not shown.</p>
      ) : null}
    </section>
  );
}

function FolderFlag({ compare }: { compare: DeploymentCompare }) {
  const folders = compare.folders;
  if (!folders) return null;
  if (folders.unknown)
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <FolderIcon aria-hidden className="mt-px size-3.5 shrink-0" />
        Which commits change what {compare.to.environment} serves is unknown.{" "}
        {folders.problem ?? ""}
      </p>
    );
  const only = folders.onlyFrom ?? 0;
  if (only === 0 || !folders.from) return null;
  return (
    <p
      className="flex items-start gap-1.5 text-xs text-warning-foreground"
      data-release-folder-flag
    >
      <FolderIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>
        {only === 1 ? "1 commit changes" : `${only} commits change`} only{" "}
        <code className="font-mono">{folders.from}/</code>. Promoting {only === 1 ? "it" : "them"}{" "}
        changes nothing on {compare.to.environment}.
      </span>
    </p>
  );
}

/** What lies between one instance and the one it promotes into, and its promotion. */
export function DifferenceStrip({
  environmentId,
  from,
  to,
  repositoryTitle,
  board,
  identity,
  checkout,
  promotion,
  unavailable,
  disabled,
  onRequest,
}: {
  environmentId: EnvironmentId;
  from: DeploymentProject;
  to: DeploymentProject;
  repositoryTitle: string;
  /** The board being viewed, which a Port to app files on first. */
  board: string | null;
  identity: RepositoryIdentity | null;
  checkout: SyncCheckout | null;
  promotion: DeploymentPromotion | null;
  unavailable: boolean;
  disabled: boolean;
  onRequest: (request: DeploymentRequest) => void;
}) {
  // Read often enough to stay fresh: promoting is offered only on a fresh difference.
  const read = useDeliveryRead(environmentId, comparePath(from.id, to.id), { pollMs: 15_000 });
  const compare = parseDeploymentCompare(read.body);
  const stale = useStaleReading(read.readAt);
  const onTask = useOpenTask(environmentId);
  const [porting, setPorting] = useState(false);
  const ports = compare ? portRowsOf(compare) : null;
  const portSlot = (commit: string) => {
    const row = ports?.get(commit);
    return row ? (
      <PortSlot row={row} to={to.environment} onPort={() => setPorting(true)} onTask={onTask} />
    ) : null;
  };
  return (
    <div
      className="ml-4 flex min-w-0 flex-col gap-3 border-l-2 border-border py-2 pl-4"
      aria-label={`Difference between ${from.environment} and ${to.environment}`}
      data-release-strip
    >
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ArrowDownIcon aria-hidden className="size-3.5" />
        {from.environment} promotes into {to.environment}
      </p>
      <PromotionControls
        environmentId={environmentId}
        checkout={checkout}
        compare={compare}
        reading={{ readAt: read.readAt, error: read.error, stale, refresh: read.refresh }}
        from={from}
        to={to}
        promotion={promotion}
        unavailable={unavailable}
        disabled={disabled}
        onRequest={onRequest}
      />
      {read.error ? (
        <p role="alert" className="break-words text-xs text-warning-foreground">
          The difference could not be read. {read.error}
        </p>
      ) : read.isPending && !compare ? (
        <p className="text-xs text-muted-foreground">Reading the difference…</p>
      ) : !compare ? (
        <p role="alert" className="text-xs text-warning-foreground">
          This engine returned an unsupported compare. Update the engine to compare instances.
        </p>
      ) : (
        <>
          {compare.promote === "sync-hotfixes-first" ? (
            <p className="text-xs text-warning-foreground" data-release-promote="sync">
              Sync hotfixes first: {to.environment} has{" "}
              {compare.hotfixes.count === 1 ? "1 commit" : `${compare.hotfixes.count} commits`} that{" "}
              {from.environment} lacks. Bring {compare.hotfixes.count === 1 ? "it" : "them"} into{" "}
              {from.environment} before promoting.
            </p>
          ) : null}
          <FolderFlag compare={compare} />
          <div className="grid min-w-0 gap-3 lg:grid-cols-3">
            <RangeSection
              title={`On ${from.environment}, not on ${to.environment}`}
              range={compare.ahead}
              limit={compare.limit}
              identity={identity}
              onTask={onTask}
              rowExtra={portSlot}
            />
            <RangeSection
              title={`On ${to.environment}, not in ${from.environment}`}
              range={compare.hotfixes}
              limit={compare.limit}
              identity={identity}
              onTask={onTask}
            />
            <RangeSection
              title={`Waiting on ${to.environment}`}
              range={compare.waiting}
              limit={compare.limit}
              identity={identity}
              onTask={onTask}
            />
          </div>
          {compare.problem ? (
            <p className="break-words text-xs text-muted-foreground">{compare.problem}</p>
          ) : null}
          {porting ? (
            <PortDialog
              environmentId={environmentId}
              compare={compare}
              repositoryTitle={repositoryTitle}
              board={board}
              onClose={() => setPorting(false)}
              onFiled={read.refresh}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
