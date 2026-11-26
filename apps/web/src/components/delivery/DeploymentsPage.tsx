import { useAtomValue } from "@effect/atom-react";
import {
  type DeploymentProject,
  type DeploymentsSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import { GitCommitHorizontalIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { isElectron } from "../../env";
import { type DeliveryRepository, environmentForBranch } from "../../lib/delivery";
import { parseDeployments, parseDeploymentCommands } from "../../lib/deployments";
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
import { SidebarInset } from "../ui/sidebar";
import { useProjects } from "../../state/entities";
import { addedRepository, repositoryChoices } from "./BoardPicker.repositories";
import { RepositoryBrowse } from "./BoardPicker.browse";
import { BaseBranchPicker } from "./BoardPicker.branches";
import { ADD_REPOSITORY, RepositoryPicker } from "./RepositoryPicker";
import { useBoardDesktop } from "./BoardToolbar";
import { EnginePanel } from "./EnginePanel";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { BoardDelivery } from "./BoardDelivery";
import { Choice } from "./Choice";
import {
  DeploymentApproval,
  DeploymentInstances,
  MODE_LABELS,
  type DeploymentRequest,
  when,
} from "./DeploymentInstance";
import {
  firebaseFromValue,
  firebaseListingPath,
  firebaseTargetChoices,
  firebaseTargetValue,
  parseFirebaseListing,
} from "./FirebaseHosting.logic";

type SnapshotRepository = DeploymentsSnapshot["repositories"][number];

function LabelledChoice(props: {
  label: string;
  value: string;
  items: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span>{props.label}</span>
      <Choice {...props} placeholder={`Choose ${props.label.toLowerCase()}`} />
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

/**
 * One deployment's settings. Everything is chosen from what T3 or the engine lists: the
 * repository, the branch, and for Firebase Hosting the project and target the engine read.
 */
export function Configuration({
  environmentId,
  snapshot,
  project,
  initialRepository = null,
  onClose,
  onRegistered,
  onSave,
}: {
  environmentId: EnvironmentId;
  snapshot: DeploymentsSnapshot;
  project: DeploymentProject | null;
  /** A new deployment's repository, as a board already knows it. */
  initialRepository?: string | null;
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
  const [repository, setRepository] = useState(project?.repository ?? initialRepository ?? "");
  const selected = registration.repositories.find((repo) => repo.id === repository);
  const [branch, setBranch] = useState(
    project?.branch ?? (project ? "" : (selected?.defaultBase ?? "")),
  );
  const [releaseEnvironment, setReleaseEnvironment] = useState(
    project?.environment ?? "production",
  );
  const [mode, setMode] = useState<string>(project?.mode ?? "manual");
  const [adapter, setAdapter] = useState<string>(project?.adapter ?? "command");
  const savedTarget = project?.firebase ? firebaseTargetValue(project.firebase) : "";
  const [target, setTarget] = useState(savedTarget);
  // An existing engine deployment keeps its adapter; a new one needs the engine's own checkout.
  const keepsEngine = project?.adapter === "engine" && project.repository === repository;
  const engineEligible =
    snapshot.capabilities.engine && (selected?.engineAdapter === true || keepsEngine);
  const firebaseOffered =
    snapshot.capabilities["firebase-hosting"] === true || project?.adapter === "firebase-hosting";
  const choose = (repo: SnapshotRepository) => {
    setRepository(repo.id);
    setBranch(repo.defaultBase ?? "");
    setTarget("");
    const eligible =
      snapshot.capabilities.engine &&
      (repo.engineAdapter === true ||
        (project?.adapter === "engine" && project.repository === repo.id));
    if (!eligible && adapter === "engine") setAdapter("command");
  };
  const chooseRepository = async (value: string) => {
    if (value === ADD_REPOSITORY) {
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
  const firebase = adapter === "firebase-hosting";
  const hosting = useDeliveryRead(
    firebase && selected && branch ? environmentId : null,
    selected && branch ? firebaseListingPath(selected.id, branch) : null,
  );
  const listing = hosting.error ? null : parseFirebaseListing(hosting.body);
  const targets = listing ? firebaseTargetChoices(listing) : { items: [], refused: [] };
  const targetListed = targets.items.some((item) => item.value === target);
  // A saved target stays saveable while the listing cannot be read, so mode changes still work.
  const targetUsable = targetListed || (!!target && target === savedTarget && !listing);
  const [confirmed, setConfirmed] = useState(false);
  const [commandsText, setCommandsText] = useState(
    project?.commands && project.adapter === "command"
      ? JSON.stringify(project.commands, null, 2)
      : "",
  );
  const commandResult = parseDeploymentCommands(commandsText);
  const available =
    adapter === "engine"
      ? snapshot.capabilities.engine
      : firebase
        ? snapshot.capabilities["firebase-hosting"] === true
        : snapshot.capabilities.command;
  const savedCommands = project?.adapter === adapter ? project.commands : null;
  const chosenFirebase = firebase ? firebaseFromValue(target) : null;
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
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span>Repository</span>
              <RepositoryPicker
                label="Repository"
                placeholder="Choose repository"
                size="default"
                environmentId={environmentId}
                value={repository || null}
                shown={selected?.title ?? null}
                choices={registration.choices}
                projects={registration.projects}
                projectsLabel="T3 projects, added to the engine when chosen"
                canAddFolder
                disabled={registration.registering}
                onChoose={(value) => void chooseRepository(value)}
              />
            </label>
            {registration.registering ? (
              <p role="status" className="text-sm text-muted-foreground">
                Adding the repository to the engine...
              </p>
            ) : null}
            {registration.problem && !browsing ? (
              <p role="alert" className="text-sm text-warning-foreground">
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
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span>Branch</span>
              <BaseBranchPicker
                key={`${environmentId}:${repository}`}
                ref={null}
                environmentId={environmentId}
                cwd={selected?.path ?? null}
                defaultBase={selected?.defaultBase ?? null}
                value={branch}
                onChange={setBranch}
                disabled={!selected}
                label="Branch"
                placeholder="Choose the branch this deploys"
                localNames
              />
            </label>
            <LabelledChoice
              label="Release environment"
              value={releaseEnvironment}
              items={(adapter === "engine"
                ? ["production"]
                : [
                    ...new Set([
                      "production",
                      "staging",
                      "qa",
                      "development",
                      ...(selected?.branches ?? []).map(environmentForBranch),
                      ...snapshot.projects
                        .filter((item) => item.repository === repository)
                        .map((item) => item.environment),
                      releaseEnvironment,
                    ]),
                  ]
              ).map((value) => ({ value, label: value }))}
              onChange={setReleaseEnvironment}
            />
            <p className="text-sm text-muted-foreground">
              The release environment is independent of the watched branch. Changing a branch does
              not change where it deploys.
            </p>
            <LabelledChoice
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
            <LabelledChoice
              label="Adapter"
              value={adapter}
              items={[
                { value: "command", label: "Repository commands" },
                ...(firebaseOffered
                  ? [{ value: "firebase-hosting", label: "Firebase Hosting" }]
                  : []),
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
            {firebase ? (
              <div className="flex min-w-0 flex-col gap-2">
                <LabelledChoice
                  label="Hosting target"
                  value={target}
                  items={
                    targetListed || !target
                      ? targets.items
                      : [...targets.items, { value: target, label: `${target} (saved)` }]
                  }
                  onChange={setTarget}
                />
                <p className="text-sm text-muted-foreground">
                  The engine reads the targets from .firebaserc and firebase.json at the branch's
                  fetched tip, and deploys only the chosen one, with the host's Firebase sign-in.
                </p>
                {!selected || !branch ? (
                  <p className="text-sm text-muted-foreground">
                    Choose a repository and branch to list its hosting targets.
                  </p>
                ) : hosting.error ? (
                  <p role="alert" className="break-words text-sm text-warning-foreground">
                    Hosting targets could not be read. {hosting.error}
                  </p>
                ) : hosting.isPending && !listing ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Reading hosting targets from {branch}...
                  </p>
                ) : !listing ? (
                  <p role="alert" className="text-sm text-warning-foreground">
                    This engine returned an unsupported Firebase Hosting response.
                  </p>
                ) : targets.items.length === 0 ? (
                  <p role="alert" className="text-sm text-warning-foreground">
                    {branch} lists no hosting target this preset can deploy.
                  </p>
                ) : null}
                {listing && target && !targetListed ? (
                  <p role="alert" className="text-sm text-warning-foreground">
                    The saved target is not listed on {branch}.
                  </p>
                ) : null}
                {[
                  ...(listing?.problems ?? []),
                  ...targets.refused.map((row) => `${row.label}: ${row.problem}`),
                ].map((problem) => (
                  <p key={problem} className="break-words text-xs text-warning-foreground">
                    {problem}
                  </p>
                ))}
                {selected && branch ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="self-start"
                    disabled={hosting.isPending}
                    onClick={hosting.refresh}
                  >
                    Read targets again
                  </Button>
                ) : null}
              </div>
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
                  <p role="alert" className="text-sm text-warning-foreground">
                    {commandResult.problem}
                  </p>
                ) : null}
              </div>
            ) : null}
            {!available ? (
              <p role="status" className="text-sm text-warning-foreground">
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
              !branch ||
              (adapter === "engine" && !engineEligible) ||
              (mode === "full-auto" && !confirmed) ||
              (firebase && (!targetUsable || !chosenFirebase)) ||
              (adapter === "command" &&
                (!!commandResult.problem || (!commandResult.commands && !savedCommands)))
            }
            onClick={() =>
              onSave({
                repository,
                branch,
                environment: releaseEnvironment,
                mode,
                adapter,
                ...(mode === "full-auto" ? { confirmed: true } : {}),
                ...(adapter === "command" && (commandResult.commands ?? savedCommands)
                  ? { commands: commandResult.commands ?? savedCommands }
                  : {}),
                // The preset's own setup and qualify checks are kept as saved.
                ...(firebase && chosenFirebase
                  ? {
                      firebase: chosenFirebase,
                      ...(savedCommands ? { commands: savedCommands } : {}),
                    }
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
            <div className="flex min-w-0 items-center gap-2">
              <span className="sr-only text-xs text-muted-foreground sm:not-sr-only">
                T3 environment
              </span>
              <EnvironmentPicker value={environmentId} onChoose={setEnvironment} />
            </div>
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
  const [request, setRequest] = useState<DeploymentRequest | null>(null);
  const unavailable = !enabled || stale || !!read.error || !!snapshot?.problem;
  const disabled = !allowed || unavailable || !snapshot;
  return (
    <main className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Releases by environment</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Compare runtime observations with pinned release candidates. New deployments start in
              manual mode.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {read.readAt
                ? `Snapshot read ${when(read.readAt)}`
                : "No deployment snapshot read yet"}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={!enabled} onClick={read.refresh}>
              <RefreshCwIcon aria-hidden="true" />
              Refresh
            </Button>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => setConfiguration({ project: null })}
            >
              <PlusIcon aria-hidden="true" />
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
              <GitCommitHorizontalIcon aria-hidden="true" />
              Discover commits
            </Button>
          </div>
        </div>
        {!enabled ? (
          <p>Enable Delivery in this environment's settings to manage deployments.</p>
        ) : read.error ? (
          <p role="alert" className="break-words text-warning-foreground">
            Could not read deployments. {read.error} Any releases shown below are last-known
            evidence. If this engine does not support deployments, update it first.
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
          <p role="alert" className="break-words text-warning-foreground">
            {snapshot.problem}
          </p>
        ) : null}
        {stale && snapshot ? (
          <p role="status" className="break-words text-warning-foreground">
            This reading is stale. Runtime and candidate states below are last-known evidence.
            Refresh before changing deployments.
          </p>
        ) : null}
        {!allowed && enabled ? (
          <p className="mb-4 text-sm text-muted-foreground">
            Deployment changes require delivery permission.
          </p>
        ) : null}
        {snapshot?.projects.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-sm">
            No deployments configured. Add a repository and branch, then discover merged commits.
            New deployments start in manual mode.
          </p>
        ) : null}
        <div className="flex min-w-0 flex-col gap-6">
          {enabled && environmentId ? (
            <BoardDelivery key={environmentId} environmentId={environmentId} />
          ) : null}
          {snapshot ? (
            <DeploymentInstances
              snapshot={snapshot}
              projects={snapshot.projects}
              unavailable={unavailable}
              disabled={disabled}
              onRequest={setRequest}
              onConfigure={(project) => setConfiguration({ project })}
            />
          ) : null}
        </div>
      </div>
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
        <DeploymentApproval
          environmentId={environmentId}
          request={request}
          unavailable={unavailable || !snapshot}
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
