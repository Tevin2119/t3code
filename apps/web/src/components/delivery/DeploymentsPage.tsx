import { useAtomValue } from "@effect/atom-react";
import {
  DEPLOYMENT_ENVIRONMENTS,
  DEPLOYMENT_STATES,
  type DeploymentCandidate,
  type DeploymentProject,
  type DeploymentsSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";
import { isElectron } from "../../env";
import type { DeliveryRepository } from "../../lib/delivery";
import {
  deploymentActions,
  deploymentRequestBody,
  deploymentStatus,
  parseDeployments,
  parseDeploymentCommands,
} from "../../lib/deployments";
import {
  deliveryEnvironment,
  useBoardStore,
  useDeliveryAct,
  useDeliveryEnabled,
  useDeliveryEnvironmentId,
  useDeliveryRead,
  usePersonName,
  useStaleReading,
} from "../../state/delivery";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
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
import { Textarea } from "../ui/textarea";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { useProjects } from "../../state/entities";
import { addedRepository, repositoryChoices } from "./BoardPicker.repositories";
import { RepositoryBrowse } from "./BoardPicker.browse";
import { useBoardDesktop } from "./BoardToolbar";
import { EnginePanel } from "./EnginePanel";
import { EnvironmentPicker } from "./EnvironmentPicker";

const MODE_LABELS = {
  manual: "Manual",
  "auto-qualify": "Auto-qualify",
  "full-auto": "Full auto",
} as const;
const short = (commit: string | null) => commit?.slice(0, 10) ?? "None";
const when = (iso: string) => new Date(iso).toLocaleString();
const ADD_FOLDER = "__add_folder__";
type SnapshotRepository = DeploymentsSnapshot["repositories"][number];
type Request = { title: string; path: string; body: Record<string, unknown> };

function Choice({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span>{label}</span>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
        items={items}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder={`Choose ${label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </label>
  );
}

/**
 * The repository choices the board offers: the engine's repositories, then T3 projects and any
 * folder, which are added to the engine (not to a board) when chosen.
 */
function useRepositoryRegistration(
  environmentId: EnvironmentId,
  listed: ReadonlyArray<SnapshotRepository>,
  onRegistered: () => void,
) {
  const projects = useProjects();
  const by = usePersonName();
  const addAct = useDeliveryAct(environmentId, "add repository");
  const [added, setAdded] = useState<ReadonlyArray<SnapshotRepository>>([]);
  const [registering, setRegistering] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = new Set(listed.map((repo) => repo.id));
  const repositories = [...listed, ...added.filter((repo) => !ids.has(repo.id))].filter(
    (repo) => repo.kind !== "qualification",
  );
  const choices = repositoryChoices({
    repositories: repositories.map((repo): DeliveryRepository => ({
      ...repo,
      delivery: null,
      fetch: null,
      problem: null,
    })),
    projects,
    environmentId,
  });
  const register = async (path: string, title: string): Promise<SnapshotRepository | null> => {
    if (registering) return null;
    setRegistering(true);
    setProblem(null);
    const result = await addAct("/api/repositories", { path, title, by });
    setRegistering(false);
    if (!result.ok) {
      setProblem(result.why);
      return null;
    }
    const made = addedRepository(result.body, { path, title });
    if (!made) {
      setProblem(`${title} was added. Choose it once the list is read again.`);
      onRegistered();
      return null;
    }
    const row = { ...made, engineAdapter: false };
    setAdded((current) => [...current.filter((repo) => repo.id !== made.id), row]);
    onRegistered();
    return row;
  };
  return { projects, repositories, choices, registering, problem, register };
}

function Configuration({
  environmentId,
  snapshot,
  project,
  onClose,
  onRegistered,
  onSave,
}: {
  environmentId: EnvironmentId;
  snapshot: DeploymentsSnapshot;
  project: DeploymentProject | null;
  onClose: () => void;
  onRegistered: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const registration = useRepositoryRegistration(
    environmentId,
    snapshot.repositories,
    onRegistered,
  );
  const [browsing, setBrowsing] = useState(false);
  const [repository, setRepository] = useState(project?.repository ?? "");
  const selected = registration.repositories.find((repo) => repo.id === repository);
  const [branch, setBranch] = useState(project?.branch ?? "");
  const [releaseEnvironment, setReleaseEnvironment] = useState(
    project?.environment ?? "production",
  );
  const [mode, setMode] = useState<string>(project?.mode ?? "manual");
  const [adapter, setAdapter] = useState<string>(project?.adapter ?? "command");
  // An existing engine deployment keeps its adapter; a new one needs the engine's own checkout.
  const keepsEngine = project?.adapter === "engine" && project.repository === repository;
  const engineEligible =
    snapshot.capabilities.engine && (selected?.engineAdapter === true || keepsEngine);
  const choose = (repo: SnapshotRepository) => {
    setRepository(repo.id);
    setBranch(repo.defaultBase ?? "");
    const eligible =
      snapshot.capabilities.engine &&
      (repo.engineAdapter === true ||
        (project?.adapter === "engine" && project.repository === repo.id));
    if (!eligible && adapter === "engine") setAdapter("command");
  };
  const chooseRepository = async (value: string) => {
    if (value === ADD_FOLDER) {
      setBrowsing(true);
      return;
    }
    const choice = registration.choices.find((item) => item.value === value);
    if (!choice) return;
    if (choice.kind === "engine") {
      const repo = registration.repositories.find((item) => item.id === choice.repository.id);
      if (repo) choose(repo);
      return;
    }
    const made = await registration.register(choice.folder, choice.name);
    if (made) choose(made);
  };
  const [confirmed, setConfirmed] = useState(false);
  const [commandsText, setCommandsText] = useState(
    project?.commands ? JSON.stringify(project.commands, null, 2) : "",
  );
  const commandResult = parseDeploymentCommands(commandsText);
  const available =
    adapter === "engine" ? snapshot.capabilities.engine : snapshot.capabilities.command;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{project ? "Configure deployment" : "Add deployment"}</DialogTitle>
          <DialogDescription>
            One deployment per repository and environment. Saving an existing pair updates its
            settings.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <Choice
              label="Repository"
              value={repository}
              items={[
                ...registration.choices.flatMap((choice) =>
                  choice.kind === "engine"
                    ? choice.repository.ok
                      ? [{ value: choice.value, label: choice.repository.title }]
                      : []
                    : [
                        {
                          value: choice.value,
                          label: `${choice.name} (T3 project, added when chosen)`,
                        },
                      ],
                ),
                { value: ADD_FOLDER, label: "Add a repository by its folder..." },
              ]}
              onChange={(value) => void chooseRepository(value)}
            />
            {registration.registering ? (
              <p role="status" className="text-sm text-muted-foreground">
                Adding the repository to the engine...
              </p>
            ) : null}
            {registration.problem && !browsing ? (
              <p role="alert" className="text-sm text-warning">
                {registration.problem}
              </p>
            ) : null}
            {browsing ? (
              <RepositoryBrowse
                environmentId={environmentId}
                projects={registration.projects}
                registering={registration.registering}
                problem={registration.problem}
                onCancel={() => setBrowsing(false)}
                onAdd={(path, title) =>
                  void registration.register(path, title).then((made) => {
                    if (!made) return;
                    choose(made);
                    setBrowsing(false);
                  })
                }
              />
            ) : null}
            <Choice
              label="Branch"
              value={branch}
              items={(selected?.branches ?? []).map((value) => ({ value, label: value }))}
              onChange={setBranch}
            />
            <Choice
              label="Release environment"
              value={releaseEnvironment}
              items={(adapter === "engine"
                ? ["production"]
                : [
                    ...new Set([
                      ...DEPLOYMENT_ENVIRONMENTS,
                      ...snapshot.projects.map((item) => item.environment),
                    ]),
                  ]
              ).map((value) => ({ value, label: value }))}
              onChange={setReleaseEnvironment}
            />
            <Choice
              label="Mode"
              value={mode}
              items={Object.entries(MODE_LABELS).map(([value, label]) => ({ value, label }))}
              onChange={setMode}
            />
            <p className="text-sm text-muted-foreground">
              Manual waits for each action. Auto-qualify checks merged commits and waits before
              deploying. Full auto qualifies, deploys and verifies automatically.
            </p>
            {mode === "full-auto" ? (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={confirmed}
                  onCheckedChange={(value) => setConfirmed(value === true)}
                />
                <span>
                  I authorize automatic qualification, deployment and verification of merged commits
                  in {releaseEnvironment}.
                </span>
              </label>
            ) : null}
            <Choice
              label="Adapter"
              value={adapter}
              items={[
                { value: "command", label: "Repository commands" },
                ...(engineEligible ? [{ value: "engine", label: "Built-in engine" }] : []),
              ]}
              onChange={(value) => {
                setAdapter(value);
                if (value === "engine") setReleaseEnvironment("production");
              }}
            />
            {!engineEligible && selected ? (
              <p className="text-sm text-muted-foreground">
                The built-in engine adapter releases only the engine's own checkout, when this
                engine has it configured.
              </p>
            ) : null}
            {adapter === "command" ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  Configure command argument arrays as JSON. Required keys: qualify, deploy, verify.
                  Optional: setup. Leave blank to preserve the saved commands. New deployments need
                  all three commands. Do not enter secrets.
                </p>
                <Textarea
                  aria-label="Deployment command arrays"
                  value={commandsText}
                  onChange={(event) => setCommandsText(event.target.value)}
                  placeholder={
                    '{"qualify":["npm","test"],"deploy":["npm","run","deploy"],"verify":["npm","run","verify"]}'
                  }
                />
                {commandResult.problem ? (
                  <p role="alert" className="text-sm text-warning">
                    {commandResult.problem}
                  </p>
                ) : null}
              </div>
            ) : null}
            {!available ? (
              <p role="status" className="text-sm text-warning">
                This adapter is unavailable or unconfigured on this engine. Configure it before
                running releases.
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              registration.registering ||
              !selected?.ok ||
              !selected.branches.includes(branch) ||
              (adapter === "engine" && !engineEligible) ||
              (mode === "full-auto" && !confirmed) ||
              (adapter === "command" &&
                (!!commandResult.problem || (!commandResult.commands && !project?.commands)))
            }
            onClick={() =>
              onSave({
                repository,
                branch,
                environment: releaseEnvironment,
                mode,
                adapter,
                ...(mode === "full-auto" ? { confirmed: true } : {}),
                ...(adapter === "command" && (commandResult.commands ?? project?.commands)
                  ? { commands: commandResult.commands ?? project?.commands }
                  : {}),
              })
            }
          >
            Review settings
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Approval({
  environmentId,
  request,
  onClose,
  onDone,
}: {
  environmentId: EnvironmentId;
  request: Request;
  onClose: () => void;
  onDone: () => void;
}) {
  const act = useDeliveryAct(environmentId, "deployments");
  const allowed = useAtomValue(deliveryEnvironment.act.permissionAtom(environmentId));
  const person = usePersonName();
  const setPerson = useBoardStore((state) => state.setPerson);
  const [by, setBy] = useState(person);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async () => {
    if (busy || !allowed) return;
    setBusy(true);
    setProblem(null);
    try {
      const body = deploymentRequestBody(request.path, {
        ...request.body,
        by: by.trim(),
        key,
      });
      const result = await act(request.path, body);
      if (!result.ok) {
        setProblem(result.why);
        return;
      }
      setPerson(by.trim());
      toastManager.add({
        title: request.title,
        description: "The engine accepted the request.",
        type: "success",
      });
      onDone();
    } catch {
      setProblem(
        "The deployment request could not be submitted. Check its settings and try again.",
      );
    } finally {
      setKey("");
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(value) => !value && !busy && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          <DialogDescription>
            Deployment changes always need the engine's approval passphrase, even while an approval
            window is open. T3 never saves it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(request.body, null, 2)}
            </pre>
            <Input
              aria-label="Your name"
              placeholder="Your name"
              value={by}
              disabled={busy}
              onChange={(event) => setBy(event.target.value)}
            />
            <Input
              type="password"
              autoComplete="current-password"
              aria-label="Approval passphrase or terminal key"
              placeholder="Approval passphrase or terminal key"
              value={key}
              disabled={busy}
              onChange={(event) => setKey(event.target.value)}
            />
            {!allowed ? (
              <p role="status">This connection does not have permission to change deployments.</p>
            ) : null}
            {problem ? (
              <p role="alert" className="text-sm text-warning">
                {problem}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !allowed || !by.trim() || !key} onClick={() => void submit()}>
            {busy ? "Submitting" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Candidate({
  candidate,
  disabled,
  projectBusy,
  onRequest,
  onDependencies,
}: {
  candidate: DeploymentCandidate;
  disabled: boolean;
  projectBusy: boolean;
  onRequest: (request: Request) => void;
  onDependencies: () => void;
}) {
  const attempts = candidate.attempts;
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border bg-background p-3">
      <div>
        {candidate.subject ? (
          <p className="break-words text-sm">
            {candidate.seq !== undefined ? (
              <span className="text-muted-foreground">#{candidate.seq} </span>
            ) : null}
            {candidate.subject}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">Pinned revision</p>
        <code className="break-all text-xs">{candidate.commit}</code>
      </div>
      <p className="text-xs text-muted-foreground">
        Base {short(candidate.baseCommit)}
        <br />
        Updated {when(candidate.updatedAt)}
        {candidate.liveAt ? (
          <>
            <br />
            Live since {when(candidate.liveAt)}
          </>
        ) : null}
        {candidate.liveUntil ? (
          <>
            <br />
            Replaced {when(candidate.liveUntil)}
          </>
        ) : null}
      </p>
      {candidate.phase ? (
        <p className="text-xs text-muted-foreground">Phase: {candidate.phase}</p>
      ) : null}
      {candidate.state === "blocked" && candidate.failedPhase ? (
        <p className="text-xs text-warning">Stopped during {candidate.failedPhase}</p>
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
        <p className="text-xs text-warning">
          Verification required before this release can be live.
        </p>
      ) : null}
      {candidate.problem ? <p className="text-sm text-warning">{candidate.problem}</p> : null}
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled || !["merged", "ready", "blocked"].includes(candidate.state)}
        onClick={onDependencies}
      >
        Dependencies
      </Button>
      <details className="text-xs">
        <summary className="cursor-pointer">Evidence and history</summary>
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
      </details>
      <div className="flex flex-wrap gap-1">
        {deploymentActions(candidate, projectBusy).map((action) => (
          <Button
            key={action}
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onRequest({
                title: `${action[0]!.toUpperCase()}${action.slice(1)} ${short(candidate.commit)}`,
                path: `/api/deployments/candidates/${candidate.id}/action`,
                body: { action },
              })
            }
          >
            {action[0]!.toUpperCase()}
            {action.slice(1)}
          </Button>
        ))}
      </div>
    </article>
  );
}

export function DeploymentsPage() {
  const environmentId = useDeliveryEnvironmentId();
  const setEnvironment = useBoardStore((state) => state.setDeliveryEnvironment);
  const desktop = useBoardDesktop();
  return (
    <SidebarInset>
      <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3 py-2">
            <h1 className="text-sm font-medium">Deployments</h1>
            {environmentId ? (
              <EnginePanel environmentId={environmentId} compact={!desktop} />
            ) : null}
            <EnvironmentPicker value={environmentId} onChoose={setEnvironment} />
          </div>
        </WorkspacePageHeader>
        <DeploymentsContent key={environmentId} environmentId={environmentId} />
      </div>
    </SidebarInset>
  );
}

function DeploymentsContent({ environmentId }: { environmentId: EnvironmentId | null }) {
  const enabled = useDeliveryEnabled(environmentId);
  const read = useDeliveryRead(enabled ? environmentId : null, "/api/deployments", {
    pollMs: 10_000,
  });
  const snapshot = parseDeployments(read.body);
  const stale = useStaleReading(read.readAt);
  const allowed = useAtomValue(deliveryEnvironment.act.permissionAtom(environmentId));
  const [configuration, setConfiguration] = useState<{ project: DeploymentProject | null } | null>(
    null,
  );
  const [dependencies, setDependencies] = useState<DeploymentCandidate | null>(null);
  const [request, setRequest] = useState<Request | null>(null);
  const disabled = !allowed || stale || !!read.error || !snapshot || !!snapshot.problem;
  return (
    <main className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          Merged revisions, qualified releases and what is running in each environment.
        </p>
        <Button size="sm" variant="outline" disabled={!enabled} onClick={read.refresh}>
          Refresh
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => setConfiguration({ project: null })}>
          Add deployment
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !snapshot?.projects.length}
          onClick={() =>
            setRequest({
              title: "Discover merged commits",
              path: "/api/deployments/discover",
              body: {},
            })
          }
        >
          Discover commits
        </Button>
      </div>
      {!enabled ? (
        <p>Enable Delivery in this environment's settings to manage deployments.</p>
      ) : read.error ? (
        <p role="alert" className="text-warning">
          Could not read deployments. {read.error} If this engine does not support deployments,
          update it first.
        </p>
      ) : read.isPending && !snapshot ? (
        <p>Reading deployments...</p>
      ) : !snapshot ? (
        <p role="alert">
          This engine returned an unsupported deployment response. Update the engine and T3 to
          compatible versions.
        </p>
      ) : null}
      {snapshot?.problem ? (
        <p role="alert" className="mb-4 text-warning">
          {snapshot.problem}
        </p>
      ) : null}
      {stale && snapshot ? (
        <p role="status" className="mb-4 text-warning">
          This reading is stale. Refresh before changing deployments.
        </p>
      ) : null}
      {!allowed && enabled ? (
        <p className="mb-4 text-sm text-muted-foreground">
          Deployment changes require delivery permission.
        </p>
      ) : null}
      {snapshot?.projects.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-sm">
          No deployments configured. Add a repository and branch, then discover merged commits. New
          deployments start in manual mode.
        </p>
      ) : null}
      <div className="flex flex-col gap-8">
        {snapshot?.projects.map((project) => (
          <section
            key={project.id}
            className="flex min-w-0 flex-col gap-3"
            aria-label={`${project.title} ${project.environment}`}
          >
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="font-medium">
                  {project.title}{" "}
                  <span className="text-sm text-muted-foreground">/ {project.environment}</span>
                </h2>
                <p className="break-all text-xs text-muted-foreground">
                  {project.branch} · {MODE_LABELS[project.mode]} · {project.adapter}
                </p>
              </div>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => setConfiguration({ project })}
              >
                Configure
              </Button>
            </div>
            <p className="text-sm" data-deployment-status>
              Latest merged <code>{short(project.latestCommit)}</code> · Running{" "}
              <code>{short(project.liveCommit)}</code> ·{" "}
              <span className={project.liveProblem ? "text-warning" : undefined}>
                {deploymentStatus(project)}
              </span>
              {project.liveObservedAt ? (
                <span className="text-muted-foreground">
                  {" "}
                  · Observed {when(project.liveObservedAt)}
                </span>
              ) : null}
            </p>
            {project.busy ? (
              <p role="status" className="text-sm text-muted-foreground">
                A release operation is running.
              </p>
            ) : null}
            {project.problem ? <p className="text-sm text-warning">{project.problem}</p> : null}
            {project.adapter === "command" && !project.commands ? (
              <p className="text-sm text-warning">
                Repository commands are not configured. Configure them before running a release.
              </p>
            ) : !snapshot.capabilities[project.adapter] ? (
              <p className="text-sm text-warning">
                This adapter is unavailable on this engine. Configure the engine before running a
                release.
              </p>
            ) : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {DEPLOYMENT_STATES.map((state) => {
                const candidates = snapshot.candidates.filter(
                  (candidate) => candidate.projectId === project.id && candidate.state === state,
                );
                return (
                  <section
                    key={state}
                    className="min-w-0 rounded-lg bg-muted/40 p-3"
                    aria-label={`${project.title}: ${state}`}
                  >
                    <h3 className="mb-3 text-sm font-medium capitalize">
                      {state} <span className="text-muted-foreground">{candidates.length}</span>
                    </h3>
                    <div className="flex flex-col gap-2">
                      {candidates.length ? (
                        candidates.map((candidate) => (
                          <Candidate
                            key={candidate.id}
                            candidate={candidate}
                            disabled={disabled}
                            projectBusy={!!project.busy}
                            onRequest={setRequest}
                            onDependencies={() => setDependencies(candidate)}
                          />
                        ))
                      ) : (
                        <p className="text-xs text-muted-foreground">No releases</p>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      {dependencies && snapshot ? (
        <Dependencies
          candidate={dependencies}
          snapshot={snapshot}
          onClose={() => setDependencies(null)}
          onSave={(ids) => {
            setRequest({
              title: `Set dependencies for ${short(dependencies.commit)}`,
              path: `/api/deployments/candidates/${dependencies.id}/dependencies`,
              body: { dependencies: ids },
            });
            setDependencies(null);
          }}
        />
      ) : null}
      {configuration && snapshot && environmentId ? (
        <Configuration
          environmentId={environmentId}
          snapshot={snapshot}
          project={configuration.project}
          onClose={() => setConfiguration(null)}
          onRegistered={read.refresh}
          onSave={(body) => {
            setConfiguration(null);
            setRequest({
              title: "Save deployment settings",
              path: "/api/deployments/projects",
              body,
            });
          }}
        />
      ) : null}
      {request && environmentId ? (
        <Approval
          environmentId={environmentId}
          request={request}
          onClose={() => setRequest(null)}
          onDone={() => {
            setRequest(null);
            read.refresh();
          }}
        />
      ) : null}
    </main>
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
