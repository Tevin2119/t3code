import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { deliveryProgress, deliveryTaskRequest, parseBoardDelivery } from "../../lib/boardDelivery";
import {
  deliveryEnvironment,
  useDeliveryAct,
  useDeliveryRead,
  usePersonName,
  useStaleReading,
} from "../../state/delivery";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Choice } from "./Choice";
import { TaskDisclosure } from "./TaskDisclosure";

export function BoardDelivery({
  environmentId,
  task,
}: {
  environmentId: EnvironmentId;
  task?: {
    id: string;
    origin: string;
    repository: string | null;
    base: string | null;
    held?: boolean;
    state?: string;
  };
}) {
  const read = useDeliveryRead(
    environmentId,
    task ? `/api/delivery?task=${encodeURIComponent(task.id)}` : "/api/delivery",
    { pollMs: 10_000 },
  );
  const snapshot = parseBoardDelivery(read.body);
  const stale = useStaleReading(read.readAt);
  const allowed = useAtomValue(deliveryEnvironment.act.permissionAtom(environmentId));
  const act = useDeliveryAct(environmentId, "board delivery");
  const person = usePersonName();
  const [by, setBy] = useState(person);
  const [key, setKey] = useState("");
  const [board, setBoard] = useState("");
  const [project, setProject] = useState("");
  const [route, setRoute] = useState("");
  const [autoMerge, setAutoMerge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const selectedBoard = snapshot?.boards.find((b) => b.id === board);
  const routes =
    snapshot?.routes.filter(
      (r) => !task || (r.repository === task.repository && r.base === task.base),
    ) ?? [];
  const linked = snapshot?.tracking.find((t) => t.request?.task === task?.id);
  const paused = task?.held || task?.state === "moving" || task?.state === "moved";
  const disabled = !allowed || stale || busy || !snapshot || !!read.error || !!paused;
  const submit = async (path: string, body: Record<string, unknown>) => {
    if (disabled || !key || !by.trim()) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await act(path, { ...body, by: by.trim(), key });
      if (!result.ok) setProblem(result.why);
      else read.refresh();
    } catch {
      setProblem("The engine could not confirm the request. Retry the same task to reconcile it.");
    }
    setKey("");
    setBusy(false);
  };
  const requestTask = () => {
    if (!task || !routes.some((r) => r.id === route)) return;
    try {
      void submit("/api/delivery/requests", deliveryTaskRequest(route, task, environmentId));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Choose the originating thread.");
    }
  };
  return (
    <div className="rounded-lg border border-border p-3">
      <TaskDisclosure
        title={task ? "Deliver this task" : "Board delivery routes"}
        defaultOpen={false}
      >
        <div className="mt-3 flex flex-col gap-3">
          {read.error || (!snapshot && !read.isPending) ? (
            <p role="status">
              This engine does not provide board delivery routes. Update the engine before
              configuring delivery.
            </p>
          ) : null}
          {linked ? <p role="status">{deliveryProgress(linked)}</p> : null}
          {snapshot?.problem ? <p role="status">{snapshot.problem}</p> : null}
          {paused ? (
            <p role="status">Resume this task on its board before requesting delivery.</p>
          ) : null}
          {snapshot && !task ? (
            <>
              <p className="text-sm">
                Choose a board and its deployment destination. Automatic merging is off unless
                explicitly enabled; deployment keeps its own saved mode.
              </p>
              <Input
                aria-label="Delivery route name"
                placeholder="Delivery route name"
                value={route}
                onChange={(e) => setRoute(e.target.value)}
                disabled={disabled}
              />
              <Choice
                label="Board"
                value={board}
                items={snapshot.boards.map((b) => ({
                  value: b.id,
                  label: `${b.title} / ${b.base ?? "no target branch"}`,
                }))}
                onChange={(value) => {
                  setBoard(value);
                  setProject("");
                }}
              />
              <Choice
                label="Deployment destination"
                value={project}
                items={snapshot.projects
                  .filter(
                    (p) =>
                      p.repository === selectedBoard?.repository &&
                      p.branch === selectedBoard?.base,
                  )
                  .map((p) => ({
                    value: p.id,
                    label: `${p.environment} / ${p.branch} / ${p.mode}`,
                  }))}
                onChange={setProject}
              />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={autoMerge}
                  onCheckedChange={(value) => setAutoMerge(value === true)}
                />
                Allow this route to merge approved PRs after host checks
              </label>
              <p className="text-sm text-muted-foreground">
                If no destination matches, configure a deployment above with the board's repository
                and target branch.
              </p>
              {snapshot.routes.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    {r.board} / {r.base} / {r.project}:{" "}
                    {r.auto_merge ? "automatic merge enabled" : "host merge required"}
                  </span>
                  {r.auto_merge ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={disabled || !key || !by.trim()}
                      onClick={() =>
                        void submit("/api/delivery/routes", { id: r.id, autoMerge: false })
                      }
                    >
                      Disable automatic merge
                    </Button>
                  ) : null}
                </div>
              ))}
            </>
          ) : null}
          {snapshot && task && !linked ? (
            <>
              <Choice
                label="Delivery route"
                value={route}
                items={routes.map((r) => ({
                  value: r.id,
                  label: `${r.board} / ${r.base} / ${r.project}`,
                }))}
                onChange={setRoute}
              />
              {!routes.length ? (
                <p>
                  No matching route is configured. Open Deployments and configure a board delivery
                  route for this task's repository and branch.
                </p>
              ) : null}
              <p className="text-sm">
                This reuses the existing task and originating thread. A merged PR is not a verified
                deployment.
              </p>
            </>
          ) : null}
          {snapshot && !linked ? (
            <>
              <Input
                aria-label="Delivery requester"
                placeholder="Your name"
                value={by}
                onChange={(e) => setBy(e.target.value)}
                disabled={disabled}
              />
              <Input
                aria-label="Delivery approval passphrase"
                placeholder="Approval passphrase or terminal key"
                type="password"
                autoComplete="current-password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">
                T3 does not save this credential. Automatic merge requires passphrase approval.
              </p>
              <Button
                disabled={
                  disabled ||
                  !key ||
                  !by.trim() ||
                  (task ? !route : !board || !project || !/^[\w-]{1,80}$/.test(route))
                }
                onClick={() =>
                  task
                    ? requestTask()
                    : void submit("/api/delivery/routes", {
                        id: route,
                        board,
                        project,
                        autoMerge,
                        confirmed: autoMerge,
                      })
                }
              >
                {busy ? "Submitting" : task ? "Request delivery" : "Save route"}
              </Button>
            </>
          ) : null}
          {!allowed ? <p role="status">This connection has read-only delivery access.</p> : null}
          {stale ? <p role="status">This reading is stale. Refresh before submitting.</p> : null}
          {problem ? <p role="alert">{problem}</p> : null}
          <Button size="xs" variant="ghost" onClick={read.refresh}>
            Refresh delivery status
          </Button>
        </div>
      </TaskDisclosure>
    </div>
  );
}
