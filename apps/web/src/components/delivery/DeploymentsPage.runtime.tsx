import type { DeploymentCandidate, DeploymentProject } from "@t3tools/contracts";
import { GitCommitHorizontalIcon, ServerIcon } from "lucide-react";
import { deploymentStatus } from "../../lib/deployments";

export function DeploymentRuntime({
  project,
  unavailable,
  liveRelease = null,
}: {
  project: DeploymentProject;
  unavailable: boolean;
  liveRelease?: DeploymentCandidate | null;
}) {
  const observed = !!project.liveObservedAt && Number.isFinite(Date.parse(project.liveObservedAt));
  const problem = !!project.liveProblem || !!project.problem;
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4">
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <ServerIcon aria-hidden="true" className="size-4 shrink-0" />
            Last runtime observation
          </h3>
          <p className="mt-2 break-all font-mono text-xs">
            {project.liveCommit ??
              (observed && !problem && !unavailable ? "No revision deployed" : "Unknown revision")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {observed
              ? new Date(project.liveObservedAt!).toLocaleString()
              : "Observation time unknown"}
          </p>
        </div>
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <GitCommitHorizontalIcon aria-hidden="true" className="size-4 shrink-0" />
            Latest discovered merge
          </h3>
          <p className="mt-2 break-all font-mono text-xs">
            {project.latestCommit ?? "No merged revision discovered"}
          </p>
          <p className="mt-1 break-words text-xs text-muted-foreground">
            Watched branch: {project.branch}
          </p>
        </div>
      </div>
      <p
        className={`mt-4 break-words border-t border-border pt-3 text-sm ${problem || unavailable ? "text-warning-foreground" : "text-foreground"}`}
        data-deployment-status
      >
        {deploymentStatus(project, unavailable, liveRelease)}
      </p>
      {project.problem && project.liveProblem ? (
        <p className="mt-1 break-words text-sm text-warning-foreground">{project.problem}</p>
      ) : null}
      <p className="mt-1 text-xs text-muted-foreground">
        {problem || unavailable ? "Revisions above are last-known evidence. " : null}
        A matching revision is not a current health check. Candidate history below is separate from
        runtime observations.
      </p>
    </div>
  );
}
