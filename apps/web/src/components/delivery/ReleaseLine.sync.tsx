import type {
  DeploymentProject,
  DeploymentPromotion,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { PullRequestResolveConflictsButton } from "../pullRequest/PullRequestDetailActions";
import { buildSyncConflictsPrompt } from "../pullRequest/pullRequestDetail.logic";
import { usePullRequestHandoffs } from "../pullRequest/usePullRequestActions";
import { hotfixRows, shownRows, survivalRows, type SurvivalTone } from "./ReleaseLine.logic";

/** The T3 project with the engine repository checked out on the deployments' environment. */
export type SyncCheckout = { id: ProjectId; workspaceRoot: string };

const short12 = (commit: string | null | undefined) => (commit ? commit.slice(0, 12) : null);

function SyncPullRequestLink({ promotion }: { promotion: DeploymentPromotion }) {
  const openPrLink = useOpenPrLink();
  const pr = promotion.syncPr;
  if (!pr) {
    return promotion.syncBranch ? (
      <p className="break-words text-xs text-muted-foreground">
        Sync branch <code className="font-mono">{promotion.syncBranch.name}</code>
        {promotion.hostProblem ? `. No sync PR was opened: ${promotion.hostProblem}` : null}
      </p>
    ) : null;
  }
  const label = `Sync PR${typeof pr.number === "number" ? ` #${pr.number}` : ""}`;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs" data-promotion-sync-pr>
      {pr.url ? (
        <a
          href={pr.url}
          onClick={(event) => openPrLink(event, pr.url!)}
          className="text-foreground underline-offset-2 hover:underline"
        >
          {label}
        </a>
      ) : (
        <span>{label}</span>
      )}
      {pr.head && pr.base ? (
        <span className="min-w-0 break-words text-muted-foreground">
          <code className="font-mono">{pr.head}</code> into{" "}
          <code className="font-mono">{pr.base}</code>
        </span>
      ) : null}
    </p>
  );
}

function Hotfixes({ hotfixes }: { hotfixes: NonNullable<DeploymentPromotion["hotfixes"]> }) {
  const openPrLink = useOpenPrLink();
  const { rows, hidden } = shownRows(hotfixRows(hotfixes));
  const more = hidden + Math.max(0, hotfixes.count - hotfixRows(hotfixes).length);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-promotion-hotfixes>
      <p className="text-xs font-medium text-muted-foreground">
        Hotfixes that must survive ({hotfixes.count})
      </p>
      <ul className="flex min-w-0 flex-col gap-0.5">
        {rows.map((row) => (
          <li key={row.commit} className="flex min-w-0 items-center gap-2 px-2 text-xs">
            <code className="shrink-0 font-mono text-3xs text-muted-foreground">
              {row.commit.slice(0, 7)}
            </code>
            {row.url ? (
              <a
                href={row.url}
                onClick={(event) => openPrLink(event, row.url!)}
                className="min-w-0 flex-1 break-words text-foreground underline-offset-2 hover:underline"
              >
                #{row.number} {row.label}
              </a>
            ) : (
              <span className="min-w-0 flex-1 break-words">
                {row.number === null ? "" : `#${row.number} `}
                {row.label}
              </span>
            )}
          </li>
        ))}
      </ul>
      {more > 0 || hotfixes.truncated ? (
        <p className="px-2 text-xs text-muted-foreground">
          {more > 0 ? `${more} more not shown.` : "More not listed by the engine."}
        </p>
      ) : null}
    </div>
  );
}

// Existing text tokens only: missing reads as destructive, changed as a warning.
const SURVIVAL_TEXT: Record<SurvivalTone, string> = {
  missing: "text-destructive",
  changed: "text-warning-foreground",
  kept: "text-muted-foreground",
  other: "text-muted-foreground",
};

export function SurvivalReport({
  resolution,
}: {
  resolution: NonNullable<DeploymentPromotion["resolution"]>;
}) {
  const report = resolution.report;
  if (!report) return null;
  if (report.problem) {
    return (
      <p role="alert" className="break-words text-xs text-warning-foreground">
        The survival report could not be made: {report.problem}
      </p>
    );
  }
  const { counts } = report;
  const all = survivalRows(report);
  const { rows, hidden } = shownRows(all, 12);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-promotion-survival>
      <p className="text-xs font-medium text-muted-foreground">
        Hotfix survival report for {short12(resolution.head)}
        {resolution.merged ? ", already merged" : ""}: {counts.present} present,{" "}
        <span className={counts.changed ? SURVIVAL_TEXT.changed : undefined}>
          {counts.changed} changed
        </span>
        ,{" "}
        <span className={counts.missing ? SURVIVAL_TEXT.missing : undefined}>
          {counts.missing} missing
        </span>
        {counts.superseded ? `, ${counts.superseded} superseded` : ""}
      </p>
      <ul className="flex min-w-0 flex-col gap-1">
        {rows.map((row) => {
          const loud = row.tone === "missing" || row.tone === "changed";
          return (
            <li
              key={row.key}
              className="flex min-w-0 flex-col gap-0.5 px-2 text-xs"
              data-survival-status={row.status}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className={`w-20 shrink-0 font-medium ${SURVIVAL_TEXT[row.tone]}`}>
                  {row.status}
                </span>
                <code className="min-w-0 truncate font-mono">{row.path}</code>
                <code className="shrink-0 font-mono text-3xs text-muted-foreground">
                  {row.commit.slice(0, 7)}
                </code>
              </span>
              {loud && row.excerpt.length ? (
                <pre className="ml-22 overflow-x-auto rounded-md bg-muted px-2 py-1 font-mono text-3xs">
                  {row.excerpt.join("\n")}
                </pre>
              ) : null}
            </li>
          );
        })}
      </ul>
      {hidden > 0 || report.truncated ? (
        <p className="px-2 text-xs text-muted-foreground">
          {hidden > 0 ? `${hidden} more hunks not shown.` : ""}
          {report.truncated ? " The engine checked only the first hotfixes." : ""}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A promotion's sync through a sync PR: in conflicted, T3's own Resolve conflicts hand-off for
 * that PR beside the hotfixes that must survive; in resolved, the survival report; in
 * awaiting-merge, the PR the host must merge.
 */
export function PromotionSync({
  environmentId,
  promotion,
  checkout,
  from,
  to,
}: {
  environmentId: EnvironmentId;
  promotion: DeploymentPromotion;
  checkout: SyncCheckout | null;
  from: DeploymentProject;
  to: DeploymentProject;
}) {
  const pr = promotion.syncPr;
  // The hand-off checks the PR out by its URL, so it needs the host's whole record of it.
  const handOffPr =
    pr?.url && typeof pr.number === "number" && pr.head && pr.base
      ? { url: pr.url, number: pr.number, head: pr.head, base: pr.base }
      : null;
  const detail =
    checkout && handOffPr
      ? { projectId: checkout.id, workspaceRoot: checkout.workspaceRoot, url: handOffPr.url }
      : null;
  const { handoff, startHandoff } = usePullRequestHandoffs({ environmentId, detail });
  const state = promotion.state;
  if (!promotion.syncBranch && !pr) return null;
  const resolve = () => {
    if (!handOffPr) return;
    void startHandoff("conflicts", {
      prompt: buildSyncConflictsPrompt({
        number: handOffPr.number,
        url: handOffPr.url,
        headBranch: handOffPr.head,
        baseBranch: handOffPr.base,
        promotionId: promotion.id,
        fromBranch: from.branch,
        toBranch: to.branch,
        hotfixes: promotion.hotfixes ?? { count: 0, prs: [], loose: [] },
      }),
    });
  };
  const handOffWhy = !handOffPr
    ? null
    : !checkout
      ? `Add this repository's folder as a T3 project on this environment to resolve the sync PR in a thread.`
      : null;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-promotion-sync>
      <SyncPullRequestLink promotion={promotion} />
      {state === "conflicted" ? (
        <>
          {promotion.conflict?.files?.length ? (
            <p className="break-words text-xs text-muted-foreground">
              Conflicts in{" "}
              {promotion.conflict.files.map((file, index) => (
                <span key={file}>
                  {index ? ", " : ""}
                  <code className="font-mono">{file}</code>
                </span>
              ))}
            </p>
          ) : null}
          {promotion.hotfixes ? <Hotfixes hotfixes={promotion.hotfixes} /> : null}
          {handOffPr ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <PullRequestResolveConflictsButton
                handoff={handoff}
                unavailable={!detail}
                onResolve={resolve}
              />
              {handOffWhy ? (
                <span className="text-xs text-muted-foreground">{handOffWhy}</span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {(state === "resolved" || state === "awaiting-merge") && promotion.resolution ? (
        <SurvivalReport resolution={promotion.resolution} />
      ) : null}
      {state === "awaiting-merge" ? (
        <p className="break-words text-xs text-foreground" data-promotion-host-merge>
          {from.branch} is protected, so the engine cannot push the sync. Someone with access merges
          the sync PR on the host, with a merge commit
          {promotion.resolution?.approved
            ? `; only the approved head ${short12(promotion.resolution.approved.head)} is accepted`
            : ""}
          . The promotion goes on once {from.environment} has it.
        </p>
      ) : null}
    </div>
  );
}
