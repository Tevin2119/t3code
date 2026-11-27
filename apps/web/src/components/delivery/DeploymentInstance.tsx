import { useAtomValue } from "@effect/atom-react";
import {
  type DeploymentCandidate,
  type DeploymentProject,
  type DeploymentsSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  GitBranchIcon,
  GitCommitHorizontalIcon,
  HistoryIcon,
  ServerIcon,
  Settings2Icon,
} from "lucide-react";
import { useState } from "react";
import { deploymentActions, deploymentRequestBody, parkedBranch } from "../../lib/deployments";
import {
  deliveryEnvironment,
  useBoardStore,
  useDeliveryAct,
  usePersonName,
} from "../../state/delivery";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Checkbox } from "../ui/checkbox";
import { toastManager } from "../ui/toast";
import { DeliveryApprovalDialog } from "./DeliveryApprovalDialog";
import { DeploymentRuntime } from "./DeploymentsPage.runtime";
import { ADOPT_UNKNOWN, adapterLabel, adoptChoices } from "./FirebaseHosting.logic";
import { Choice } from "./Choice";
import { TaskDisclosure } from "./TaskDisclosure";

export const MODE_LABELS = {
  manual: "Manual",
  "auto-qualify": "Auto-qualify",
  "full-auto": "Full auto",
} as const;
const short = (commit: string | null) => commit?.slice(0, 10) ?? "None";
export const when = (iso: string) =>
  Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString() : "Unknown time";
export type DeploymentRequest = {
  title: string;
  path: string;
  body: Record<string, unknown>;
  /** Run once the engine accepted it, for reads the request changed beyond the snapshot. */
  after?: () => void;
};

export function DeploymentApproval({
  environmentId,
  request,
  unavailable,
  onClose,
  onDone,
}: {
  environmentId: EnvironmentId;
  request: DeploymentRequest;
  unavailable: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const act = useDeliveryAct(environmentId, "deployments");
  const allowed = useAtomValue(deliveryEnvironment.act.permissionAtom(environmentId));
  const person = usePersonName();
  const setPerson = useBoardStore((state) => state.setPerson);
  return (
    <DeliveryApprovalDialog
      title={request.title}
      description="Deployment changes always need the engine's approval passphrase, even while an approval window is open. T3 never saves it."
      person={person}
      nameField
      keyLabel="Approval passphrase"
      allowed={allowed}
      forbidden="This connection does not have permission to change deployments."
      unavailable={unavailable}
      submitLabel="Confirm"
      busyLabel="Submitting"
      failure="The deployment request could not be submitted. Check its settings and try again."
      onSubmit={({ by, key }) =>
        act(request.path, deploymentRequestBody(request.path, { ...request.body, by, key }))
      }
      onDone={(by) => {
        setPerson(by);
        toastManager.add({
          title: request.title,
          description: "The engine accepted the request.",
          type: "success",
        });
        request.after?.();
        onDone();
      }}
      onClose={onClose}
    >
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
        {JSON.stringify(request.body, null, 2)}
      </pre>
    </DeliveryApprovalDialog>
  );
}

const actionLabel = (action: string) => `${action[0]!.toUpperCase()}${action.slice(1)}`;

function Candidate({
  candidate,
  adapter,
  watchedBranch,
  unavailable,
  disabled,
  projectBusy,
  onRequest,
  onAdopt,
  onDependencies,
}: {
  candidate: DeploymentCandidate;
  adapter: DeploymentProject["adapter"];
  watchedBranch: string;
  unavailable: boolean;
  disabled: boolean;
  projectBusy: boolean;
  onRequest: (request: DeploymentRequest) => void;
  onAdopt: () => void;
  onDependencies: () => void;
}) {
  const attempts = candidate.attempts;
  const parkedOn = parkedBranch(candidate, watchedBranch);
  const evidence = candidate.evidence as { site?: unknown; servedFolder?: unknown } | null;
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-background p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={candidate.state === "blocked" ? "warning" : "secondary"}>
          {unavailable
            ? `${candidate.state} · last known`
            : candidate.state === "live"
              ? "Live · recorded"
              : candidate.state}
        </Badge>
        {candidate.seq !== undefined ? (
          <span className="text-xs text-muted-foreground">Release #{candidate.seq}</span>
        ) : null}
      </div>
      <div className="min-w-0">
        <h4 className="break-words text-sm font-medium">
          {candidate.subject || `Release ${short(candidate.commit)}`}
        </h4>
        <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          <GitCommitHorizontalIcon aria-hidden="true" className="size-3.5 shrink-0" />
          Pinned revision
        </p>
        <code className="break-all text-xs">{candidate.commit}</code>
      </div>
      <p className="text-xs text-muted-foreground">
        Base {short(candidate.baseCommit)}
        <br />
        Updated {when(candidate.updatedAt)}
        {candidate.liveAt ? (
          <>
            <br />
            Verified live at {when(candidate.liveAt)}
          </>
        ) : null}
        {candidate.liveUntil ? (
          <>
            <br />
            Replaced {when(candidate.liveUntil)}
          </>
        ) : null}
        {typeof evidence?.site === "string" ? (
          <>
            <br />
            Site {evidence.site}
            {typeof evidence.servedFolder === "string" ? ` · serves ${evidence.servedFolder}/` : ""}
          </>
        ) : null}
      </p>
      {parkedOn ? (
        <p className="text-xs text-muted-foreground">
          Parked: made from {parkedOn}, which this instance no longer watches. It is current work
          again once {parkedOn} is watched.
        </p>
      ) : null}
      {candidate.phase ? (
        <p className="text-xs text-muted-foreground">Phase: {candidate.phase}</p>
      ) : null}
      {candidate.state === "blocked" && candidate.failedPhase ? (
        <p className="text-xs text-warning-foreground">Stopped during {candidate.failedPhase}</p>
      ) : null}
      {attempts && (attempts.qualify > 0 || attempts.deploy > 0) ? (
        <p className="text-xs text-muted-foreground">
          Attempts: qualify {attempts.qualify}, deploy {attempts.deploy}
        </p>
      ) : null}
      {candidate.cancelRequested ? (
        <p role="status" className="text-xs text-muted-foreground">
          Cancel requested by {candidate.cancelRequested}. It stops at the next safe point.
        </p>
      ) : null}
      {candidate.needsVerify ? (
        <p className="text-xs text-warning-foreground">
          Verification required before this release can be live.
        </p>
      ) : null}
      {candidate.state === "live" || candidate.liveAt ? (
        <p className="text-xs text-muted-foreground">
          Recorded candidate evidence, not a current runtime health check.
        </p>
      ) : null}
      {candidate.problem ? (
        <p className="break-words text-sm text-warning-foreground">{candidate.problem}</p>
      ) : null}
      <div className="min-w-0 text-xs">
        <TaskDisclosure title="Evidence, dependencies and history" defaultOpen={false}>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all">
            {JSON.stringify(
              {
                evidence: candidate.evidence,
                dependencies: candidate.dependencies,
                events: candidate.events,
              },
              null,
              2,
            )}
          </pre>
        </TaskDisclosure>
      </div>
      <div className="mt-auto flex flex-wrap gap-2">
        {deploymentActions(candidate, projectBusy, adapter, watchedBranch).map((action) => (
          <Button
            key={action}
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              action === "adopt"
                ? onAdopt()
                : onRequest({
                    title: `${actionLabel(action)} ${short(candidate.commit)}`,
                    path: `/api/deployments/candidates/${candidate.id}/action`,
                    body: { action },
                  })
            }
          >
            {actionLabel(action)}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || !["merged", "ready", "blocked"].includes(candidate.state)}
          onClick={onDependencies}
        >
          Dependencies
        </Button>
      </div>
    </article>
  );
}

/** One instance per project: its runtime as the engine reports it, and its release candidates. */
export function DeploymentInstances({
  snapshot,
  projects,
  unavailable,
  disabled,
  onRequest,
  onConfigure,
}: {
  snapshot: DeploymentsSnapshot;
  projects: ReadonlyArray<DeploymentProject>;
  unavailable: boolean;
  disabled: boolean;
  onRequest: (request: DeploymentRequest) => void;
  onConfigure: (project: DeploymentProject) => void;
}) {
  const [dependencies, setDependencies] = useState<DeploymentCandidate | null>(null);
  const [adopting, setAdopting] = useState<DeploymentCandidate | null>(null);
  return (
    <>
      {projects.map((project) => {
        const candidates = snapshot.candidates.filter(
          (candidate) => candidate.projectId === project.id,
        );
        const releases = candidates.filter((candidate) => candidate.state !== "superseded");
        const history = candidates.filter((candidate) => candidate.state === "superseded");
        const renderCandidate = (candidate: DeploymentCandidate) => (
          <Candidate
            key={candidate.id}
            candidate={candidate}
            adapter={project.adapter}
            watchedBranch={project.branch}
            unavailable={unavailable}
            disabled={disabled}
            projectBusy={!!project.busy}
            onRequest={onRequest}
            onAdopt={() => setAdopting(candidate)}
            onDependencies={() => setDependencies(candidate)}
          />
        );
        return (
          <section
            key={project.id}
            className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-card p-4 md:p-5"
            aria-label={`${project.title} ${project.environment}`}
          >
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1 basis-48">
                <p className="flex items-start gap-2 text-sm font-medium">
                  <ServerIcon
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="break-words">
                    <span className="font-normal text-muted-foreground">Release environment: </span>
                    {project.environment}
                  </span>
                </p>
                <h2 className="mt-1 break-words text-lg font-semibold">{project.title}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
                  <span className="flex min-w-0 items-start gap-1">
                    <GitBranchIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="break-all">{project.branch}</span>
                  </span>
                  <Badge variant="outline">{MODE_LABELS[project.mode]}</Badge>
                  <span className="break-words">{adapterLabel(project)}</span>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => onConfigure(project)}
              >
                <Settings2Icon aria-hidden="true" />
                Configure
              </Button>
            </div>
            <DeploymentRuntime
              project={project}
              unavailable={unavailable}
              liveRelease={
                candidates.find((candidate) => candidate.id === project.liveCandidate) ?? null
              }
            />
            {project.busy ? (
              <p role="status" className="text-sm text-muted-foreground">
                A release operation is running. Other releases can only be cancelled until it
                finishes.
              </p>
            ) : null}
            {project.adapter === "command" && !project.commands ? (
              <p className="text-sm text-warning-foreground">
                Repository commands are not configured. Configure them before running a release.
              </p>
            ) : !snapshot.capabilities[project.adapter] ? (
              <p className="text-sm text-warning-foreground">
                This adapter is unavailable on this engine. Configure the engine before running a
                release.
              </p>
            ) : null}
            <div>
              <h3 className="mb-3 text-sm font-medium">
                Release candidates{" "}
                <span className="text-muted-foreground">({releases.length})</span>
              </h3>
              {releases.length ? (
                <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {releases.map(renderCandidate)}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                  No active candidates. Discover commits to read the watched branch.
                </p>
              )}
            </div>
            {history.length ? (
              <div className="min-w-0 border-t border-border pt-3">
                <TaskDisclosure
                  title={
                    <>
                      <HistoryIcon aria-hidden="true" className="mx-1 inline size-4" />
                      Superseded releases ({history.length})
                    </>
                  }
                  defaultOpen={false}
                >
                  <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {history.map(renderCandidate)}
                  </div>
                </TaskDisclosure>
              </div>
            ) : null}
          </section>
        );
      })}
      {dependencies ? (
        <Dependencies
          candidate={dependencies}
          snapshot={snapshot}
          onClose={() => setDependencies(null)}
          onSave={(ids) => {
            onRequest({
              title: `Set dependencies for ${short(dependencies.commit)}`,
              path: `/api/deployments/candidates/${dependencies.id}/dependencies`,
              body: { dependencies: ids },
            });
            setDependencies(null);
          }}
        />
      ) : null}
      {adopting ? (
        <Adopt
          candidate={adopting}
          candidates={snapshot.candidates}
          onClose={() => setAdopting(null)}
          onSave={(commit) => {
            onRequest({
              title: `Adopt what runs before ${short(adopting.commit)}`,
              path: `/api/deployments/candidates/${adopting.id}/action`,
              body: { action: "adopt", ...(commit ? { commit } : {}) },
            });
            setAdopting(null);
          }}
        />
      ) : null}
    </>
  );
}

function Adopt({
  candidate,
  candidates,
  onClose,
  onSave,
}: {
  candidate: DeploymentCandidate;
  candidates: ReadonlyArray<DeploymentCandidate>;
  onClose: () => void;
  onSave: (commit: string | null) => void;
}) {
  const items = adoptChoices(candidate, candidates);
  const [choice, setChoice] = useState(ADOPT_UNKNOWN);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Adopt what runs now</DialogTitle>
          <DialogDescription>
            This site serves no release stamp yet, so the engine cannot read what runs. Say what
            runs before {short(candidate.commit)} deploys. The engine records your name, uses it for
            one deploy, and never takes it as verification.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span>What runs on the site</span>
            <Choice
              label="What runs on the site"
              value={choice}
              items={items}
              onChange={setChoice}
            />
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSave(choice === ADOPT_UNKNOWN ? null : choice)}>
            Review adoption
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Dependencies({
  candidate,
  snapshot,
  onClose,
  onSave,
}: {
  candidate: DeploymentCandidate;
  snapshot: DeploymentsSnapshot;
  onClose: () => void;
  onSave: (ids: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>(
    Array.isArray(candidate.dependencies)
      ? candidate.dependencies.filter((id): id is string => typeof id === "string")
      : [],
  );
  const choices = snapshot.candidates.filter(
    (other) => other.id !== candidate.id && other.state !== "superseded",
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Release dependencies</DialogTitle>
          <DialogDescription>
            Choose releases that must be live before this revision deploys. The engine checks for
            dependency cycles.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex max-h-80 flex-col gap-3 overflow-auto">
            {choices.length === 0 ? (
              <p>No other releases are available.</p>
            ) : (
              choices.map((other) => (
                <label key={other.id} className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={selected.includes(other.id)}
                    onCheckedChange={(checked) =>
                      setSelected((ids) =>
                        checked ? [...ids, other.id] : ids.filter((id) => id !== other.id),
                      )
                    }
                  />
                  <span>
                    {snapshot.projects.find((project) => project.id === other.projectId)?.title ??
                      other.projectId}{" "}
                    ·{" "}
                    {snapshot.projects.find((project) => project.id === other.projectId)
                      ?.environment ?? "Unknown environment"}{" "}
                    · {short(other.commit)} · {other.state}
                  </span>
                </label>
              ))
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSave(selected)}>Review dependencies</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
