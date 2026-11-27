import type {
  DeploymentProject,
  DeploymentsSnapshot,
  EnvironmentId,
  RepositoryIdentity,
} from "@t3tools/contracts";
import { GitBranchIcon, ServerIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useProjects } from "../../state/entities";
import { RelativeTime } from "../RelativeTime";
import { Badge } from "../ui/badge";
import { DeploymentInstances, MODE_LABELS } from "./DeploymentInstance";
import { InstanceChip } from "./ReleaseLine.chip";
import { DifferenceStrip } from "./ReleaseLine.compare";
import {
  instanceFacts,
  promotesInto,
  releaseLinesOf,
  repositoryIdentityFor,
  repositoryProjectFor,
  stripPromotion,
} from "./ReleaseLine.logic";
import { TaskDisclosure } from "./TaskDisclosure";

const short = (commit: string) => commit.slice(0, 10);

type InstanceActions = Omit<ComponentProps<typeof DeploymentInstances>, "snapshot" | "projects">;

function InstanceCard({
  project,
  snapshot,
  actions,
}: {
  project: DeploymentProject;
  snapshot: DeploymentsSnapshot;
  actions: InstanceActions;
}) {
  const facts = instanceFacts(project, snapshot.candidates);
  const releases = snapshot.candidates.filter(
    (candidate) => candidate.projectId === project.id && candidate.state !== "superseded",
  ).length;
  return (
    <article
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4"
      aria-label={`${project.title} ${project.environment}`}
      data-release-instance={project.environment}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ServerIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{project.environment}</h3>
        <InstanceChip tone={facts.tone} label={facts.chip} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1">
          <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="break-all">{project.branch}</span>
        </span>
        <Badge variant="outline" size="sm">
          {MODE_LABELS[project.mode]}
        </Badge>
        {facts.target ? <span className="break-words">Firebase {facts.target}</span> : null}
        {facts.servedFolder ? (
          <span>
            serves <code className="font-mono">{facts.servedFolder}/</code>
          </span>
        ) : null}
      </div>
      <dl className="flex min-w-0 flex-col gap-1 text-xs">
        <div className="flex min-w-0 gap-3">
          <dt className="w-14 shrink-0 text-muted-foreground">Live</dt>
          <dd className="min-w-0 break-words">
            {facts.live.commit ? (
              <>
                <code className="font-mono">{short(facts.live.commit)}</code>
                {facts.live.observedAt ? (
                  <>
                    {" "}
                    · observed <RelativeTime timestamp={facts.live.observedAt} />
                  </>
                ) : null}
                {facts.live.by
                  ? ` · ${facts.live.by.how === "adopted" ? "adopted by" : "deployed by"} ${facts.live.by.name}`
                  : null}
              </>
            ) : (
              <span className="text-muted-foreground">Nothing known to run here</span>
            )}
          </dd>
        </div>
        {facts.waiting ? (
          <div className="flex min-w-0 gap-3">
            <dt className="w-14 shrink-0 text-muted-foreground">Waiting</dt>
            <dd className="min-w-0 break-words">
              Branch tip <code className="font-mono">{short(facts.waiting.commit)}</code> is ahead
              of live
              {facts.waiting.state ? ` · candidate ${facts.waiting.state}` : " · no candidate yet"}
            </dd>
          </div>
        ) : null}
      </dl>
      {project.liveProblem || project.problem ? (
        <p className="break-words text-xs text-warning-foreground">
          {project.liveProblem ?? project.problem}
        </p>
      ) : null}
      <div className="min-w-0 border-t border-border pt-1">
        <TaskDisclosure title={`Runtime, releases and actions (${releases})`} defaultOpen={false}>
          <DeploymentInstances snapshot={snapshot} projects={[project]} {...actions} />
        </TaskDisclosure>
      </div>
    </article>
  );
}

/**
 * One release line per repository: its instances in promotion order, and between each instance
 * and the one it promotes into, what lies on one and not the other, with its promotion. Release
 * actions stay in each instance's detail, the cards Deployments has always shown.
 */
export function ReleaseLines({
  environmentId,
  snapshot,
  projects,
  ...actions
}: InstanceActions & {
  environmentId: EnvironmentId | null;
  snapshot: DeploymentsSnapshot;
  /** The projects to show; a board passes its repository's only. */
  projects?: ReadonlyArray<DeploymentProject>;
}) {
  const t3Projects = useProjects();
  const lines = releaseLinesOf({ ...snapshot, projects: projects ?? snapshot.projects });
  return (
    <>
      {lines.map((line) => {
        const path = snapshot.repositories.find((entry) => entry.id === line.repository)?.path;
        const identity: RepositoryIdentity | null = repositoryIdentityFor(path, t3Projects);
        const checkout = repositoryProjectFor(path, t3Projects, environmentId);
        return (
          <section
            key={line.repository}
            className="flex min-w-0 flex-col gap-2"
            aria-label={`${line.title} release line`}
            data-release-line={line.repository}
          >
            <h2 className="text-base font-semibold">{line.title}</h2>
            {line.problem ? (
              <p role="alert" className="break-words text-xs text-warning-foreground">
                {line.problem}
              </p>
            ) : null}
            {line.instances.map((project, index) => {
              const next = line.instances[index + 1];
              return (
                <div key={project.id} className="flex min-w-0 flex-col gap-2">
                  <InstanceCard project={project} snapshot={snapshot} actions={actions} />
                  {next && environmentId && promotesInto(project, next) ? (
                    <DifferenceStrip
                      environmentId={environmentId}
                      from={project}
                      to={next}
                      identity={identity}
                      checkout={checkout}
                      promotion={stripPromotion(snapshot.promotions, project.id, next.id)}
                      unavailable={actions.unavailable}
                      disabled={actions.disabled}
                      onRequest={actions.onRequest}
                    />
                  ) : null}
                </div>
              );
            })}
          </section>
        );
      })}
    </>
  );
}
