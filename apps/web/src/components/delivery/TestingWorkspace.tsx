import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import {
  glassRecord as record,
  glassRows as rows,
  glassText as text,
  glassRunState,
} from "../../lib/lookingGlass";
import { useDeliveryAct, useDeliveryRead, usePersonName } from "../../state/delivery";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const control = "w-full min-w-0 rounded-md border border-input bg-background px-2 py-1.5 text-sm";
const example = JSON.stringify(
  [
    {
      id: "unit",
      command: ["node", "--test", "--test-reporter=tap", "test/example.test.mjs"],
      timeoutMs: 60000,
      reporter: "node-tap",
      minimumTests: 1,
      criterion: "Describe the required behavior",
      paths: [],
    },
  ],
  null,
  2,
);

/** All requests go through the selected environment's existing authenticated relay. */
export function TestingWorkspace({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly onClose: () => void;
}) {
  const host = useDeliveryRead(environmentId, "/api/looking-glass");
  const setup = record(host.body);
  const projects = rows(setup.projects);
  const [projectId, setProjectId] = useState("");
  const [runId, setRunId] = useState("");
  const selectedId = projectId || text(projects[0]?.id);
  const detail = useDeliveryRead(
    environmentId,
    selectedId ? `/api/looking-glass/projects/${selectedId}` : null,
    { pollMs: 5000 },
  );
  const project = record(detail.body);
  const history = rows(project.runs);
  const selectedRun = runId || text(history[0]?.id);
  const result = useDeliveryRead(
    environmentId,
    selectedRun ? `/api/looking-glass/runs/${selectedRun}` : null,
    { pollMs: 3000 },
  );
  const evidence = record(result.body);
  const candidate = record(record(project.inspection).candidate);
  const [editing, setEditing] = useState(false);
  const [newId, setNewId] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [checks, setChecks] = useState(example);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState("");
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [models, setModels] = useState<Record<string, string>>({});
  const [independent, setIndependent] = useState(false);
  const act = useDeliveryAct(environmentId, "application checks");
  const person = usePersonName();
  const pendingRun = useRef<{ key: string; requestId: string } | null>(null);
  const harnesses = rows(setup.harnesses).filter((h) => h.installed === true);
  const selectedHarnesses = harnesses.filter((h) => chosen[text(h.id)]);
  const state = glassRunState(result.body, selectedRun);

  async function send(route: string, body: unknown) {
    setBusy(true);
    setMessage("");
    try {
      const answer = await act(route, body);
      if (!answer.ok) {
        setMessage(answer.why);
        return null;
      }
      host.refresh();
      detail.refresh();
      result.refresh();
      return record(answer.body);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(checks);
    } catch {
      setMessage("Checks must be a valid JSON array.");
      return;
    }
    const saved = await send("/api/looking-glass/projects", {
      id: newId,
      repositoryId,
      checks: parsed,
      revision,
    });
    if (saved) {
      setProjectId(text(saved.id));
      setRunId("");
      setEditing(false);
    }
  }
  async function start() {
    const key = JSON.stringify([selectedId, candidate.commit, project.contractDigest]);
    if (pendingRun.current?.key !== key)
      pendingRun.current = { key, requestId: crypto.randomUUID() };
    const job = await send(`/api/looking-glass/projects/${selectedId}/run`, {
      requestId: pendingRun.current.requestId,
      commit: candidate.commit,
      contractDigest: project.contractDigest,
    });
    if (job) {
      setRunId(text(job.id));
      pendingRun.current = null;
    }
  }
  const atlas = record(project.atlas);
  const nodes = rows(atlas.nodes).filter((node) =>
    text(node.label).toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="flex max-h-[94dvh] w-[96vw] max-w-5xl flex-col">
        <DialogHeader>
          <DialogTitle>Application checks</DialogTitle>
          <DialogDescription>
            Test a registered repository. Use your local harnesses when you want help investigating.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-4 pb-3">
            {host.error ? (
              <p role="alert">The testing service could not be read. Refresh after reconnecting.</p>
            ) : null}
            {setup.configured === false ? (
              <p>
                Looking Glass is not enabled on this environment. Set LOOKING_GLASS_ROOT to its
                checkout when starting PaperClip.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Test project"
                className={`${control} flex-1`}
                value={selectedId}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setRunId("");
                }}
              >
                {!projects.length ? <option value="">No test projects yet</option> : null}
                {projects.map((p) => (
                  <option key={text(p.id)} value={text(p.id)}>
                    {text(p.id)}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                disabled={setup.configured !== true}
                onClick={() => {
                  setEditing(true);
                  setNewId("");
                  setRevision(0);
                  setChecks(example);
                  setRepositoryId("");
                }}
              >
                Add project
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  host.refresh();
                  detail.refresh();
                  result.refresh();
                }}
              >
                Refresh
              </Button>
            </div>
            {message ? (
              <p role="status" className="break-words text-sm">
                {message}
              </p>
            ) : null}
            {editing ? (
              <section
                className="flex flex-col gap-2 rounded-lg border p-3"
                aria-label="Configure checks"
              >
                <label className="text-xs">
                  Project name
                  <input
                    className={control}
                    value={newId}
                    disabled={revision > 0}
                    placeholder="my-application"
                    onChange={(event) => setNewId(event.target.value)}
                  />
                </label>
                <label className="text-xs">
                  Repository
                  <select
                    className={control}
                    value={repositoryId}
                    onChange={(event) => setRepositoryId(event.target.value)}
                  >
                    <option value="">Choose a repository on this environment</option>
                    {rows(setup.repositories)
                      .filter((r) => r.ok === true)
                      .map((r) => (
                        <option key={text(r.id)} value={text(r.id)}>
                          {text(r.title)}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="text-xs">
                  Required checks
                  <textarea
                    className={`${control} min-h-48 font-mono text-xs`}
                    value={checks}
                    onChange={(event) => setChecks(event.target.value)}
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  Commands run on this environment with its user permissions. Use executable and
                  argument arrays. Node TAP and Python unittest report test counts; exit-only checks
                  report command success. Checks must stop their own background services.
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy || !newId || !repositoryId}
                    onClick={() => void save()}
                  >
                    Save checks
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </section>
            ) : null}
            {selectedId && project.id === selectedId ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {text(candidate.commit).slice(0, 12)}
                    {candidate.dirty ? " · uncommitted changes" : ""}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setEditing(true);
                      setNewId(selectedId);
                      setRepositoryId(text(project.repositoryId));
                      setRevision(typeof project.revision === "number" ? project.revision : 0);
                      setChecks(JSON.stringify(record(project.project).checks, null, 2));
                    }}
                  >
                    Edit checks
                  </Button>
                  <Button
                    size="sm"
                    disabled={
                      busy ||
                      Boolean(detail.error) ||
                      candidate.dirty !== false ||
                      state === "running"
                    }
                    onClick={() => void start()}
                  >
                    Run checks
                  </Button>
                </div>
                {detail.error ? (
                  <p role="alert">Project information is unavailable. Refresh before running.</p>
                ) : null}
                <section className="flex flex-col gap-2" aria-label="Run evidence">
                  <select
                    className={control}
                    aria-label="Check run"
                    value={selectedRun}
                    onChange={(event) => setRunId(event.target.value)}
                  >
                    {!history.length ? <option value="">No runs yet</option> : null}
                    {history.map((job) => (
                      <option key={text(job.id)} value={text(job.id)}>
                        {text(job.startedAt)} · {text(job.status)}
                      </option>
                    ))}
                  </select>
                  {selectedRun ? (
                    <p role="status" className="text-sm font-medium">
                      {result.error ? "Evidence unavailable" : state}
                    </p>
                  ) : null}
                  {state === "running" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void send(`/api/looking-glass/runs/${selectedRun}/cancel`, {})}
                    >
                      Cancel run
                    </Button>
                  ) : null}
                  <ul className="space-y-1 text-xs">
                    {rows(record(evidence.report).checks).map((check) => (
                      <li key={text(check.id)}>
                        {text(check.id)}: {text(check.status)}
                        {record(check.summary).verified === true
                          ? ` · ${String(record(check.summary).passed)} passing tests reported`
                          : " · no verified test count"}
                      </li>
                    ))}
                  </ul>
                  {Array.isArray(record(evidence.verification).problems) ? (
                    <p className="text-xs text-muted-foreground">
                      {(record(evidence.verification).problems as unknown[])
                        .filter((p) => typeof p === "string")
                        .join(" ")}
                    </p>
                  ) : null}
                </section>
                <details className="rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm">
                    Source inventory and declared check links
                  </summary>
                  <p className="my-2 text-xs text-muted-foreground">
                    Files and links configured for checks. This does not establish runtime
                    connections or coverage.
                  </p>
                  <input
                    className={control}
                    aria-label="Filter source inventory"
                    placeholder="Find a file or check"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                  <ul className="mt-2 max-h-48 overflow-auto font-mono text-xs">
                    {nodes.slice(0, 150).map((node) => (
                      <li key={text(node.id)} className="py-0.5 break-all">
                        {text(node.label)}
                        {rows(atlas.edges)
                          .filter((edge) => edge.to === node.id)
                          .map((edge) => ` ← ${text(edge.from)}`)
                          .join("")}
                      </li>
                    ))}
                  </ul>
                  {nodes.length > 150 || atlas.truncated === true ? (
                    <p className="text-xs">Partial inventory. Narrow the filter to find a file.</p>
                  ) : null}
                </details>
                <details className="rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm">
                    Ask a local harness to investigate
                  </summary>
                  <p className="my-2 text-xs text-muted-foreground">
                    One is enough. These are installed programs; sign-in and quota are checked when
                    they run. The review uses the tested commit and cannot approve a change.
                  </p>
                  {!harnesses.length ? (
                    <p className="text-sm">
                      No supported harness found on this environment. Tests still work. Install and
                      sign in to a harness, then refresh.
                    </p>
                  ) : null}
                  {harnesses.map((h) => (
                    <div key={text(h.id)} className="my-2 flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={chosen[text(h.id)] ?? false}
                          onChange={(event) =>
                            setChosen({ ...chosen, [text(h.id)]: event.target.checked })
                          }
                        />
                        {text(h.id)}
                      </label>
                      {chosen[text(h.id)] && h.modelSelectable === true ? (
                        <input
                          className={`${control} flex-1`}
                          aria-label={`${text(h.id)} model`}
                          placeholder="Use harness default model"
                          value={models[text(h.id)] ?? ""}
                          onChange={(event) =>
                            setModels({ ...models, [text(h.id)]: event.target.value })
                          }
                        />
                      ) : null}
                    </div>
                  ))}
                  <label className="my-2 flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={independent}
                      onChange={(event) => setIndependent(event.target.checked)}
                    />
                    Require at least two known provider families
                  </label>
                  <Button
                    size="sm"
                    disabled={
                      busy ||
                      !selectedRun ||
                      state === "running" ||
                      !evidence.report ||
                      !selectedHarnesses.length
                    }
                    onClick={async () => {
                      const answer = await send(
                        `/api/looking-glass/runs/${selectedRun}/investigate`,
                        {
                          harnesses: selectedHarnesses.map((h) => ({
                            harness: text(h.id),
                            model: models[text(h.id)] || null,
                          })),
                          minimumProviders: independent ? 2 : 1,
                          by: person,
                        },
                      );
                      if (answer)
                        setMessage(
                          `Review task #${String(record(answer.task).number ?? "")} is on the board. ${text(answer.independence)}.`,
                        );
                    }}
                  >
                    Start investigation
                  </Button>
                </details>
              </>
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
