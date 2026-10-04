import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { parseAllocation, parseShared, sharedLanes } from "../../lib/deliveryShared";
import { useDeliveryAct, useDeliveryRead } from "../../state/delivery";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";

type SharedBoardProps = {
  environmentId: EnvironmentId | null;
  taskId?: string;
  onOpen?: (id: string) => void;
};

export function SharedBoard(props: SharedBoardProps) {
  return (
    <SharedBoardContent key={`${props.environmentId}:${props.taskId ?? "board"}`} {...props} />
  );
}

function SharedBoardContent(props: SharedBoardProps) {
  const read = useDeliveryRead(props.environmentId, "/api/shared", { pollMs: 5000 });
  const view = useMemo(() => parseShared(read.body), [read.body]);
  const act = useDeliveryAct(props.environmentId, "shared allocation");
  const [boardId, setBoardId] = useState("");
  const [query, setQuery] = useState("");
  const [selection, setTaskId] = useState<string | null>(null);
  const taskId = props.taskId ?? selection;
  const [policyKey, setPolicyKey] = useState("");
  const [moveKey, setMoveKey] = useState("");
  const [moveAccepted, setMoveAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const allocation = useDeliveryRead(
    props.environmentId,
    taskId ? `/api/shared/tasks/${taskId}/allocation` : null,
    { pollMs: 5000 },
  );
  const choices = useMemo(() => parseAllocation(allocation.body), [allocation.body]);
  const chosen = view?.tasks.find((t) => t.id === taskId);
  const currentMove = view?.moves.find(
    (move) => move.id === chosen?.moving && move.root === chosen?.id,
  );
  const canCancelMove =
    currentMove &&
    (currentMove.state === "asked" || currentMove.state === "exported") &&
    (currentMove.destination === view?.machine ||
      (currentMove.state === "asked" && currentMove.source === view?.machine));
  const board = view?.boards.find((b) => b.id === boardId);
  const tasks =
    view?.tasks.filter(
      (t) =>
        (!props.taskId || t.id === props.taskId) &&
        (!boardId || t.board === boardId) &&
        t.title.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  async function run(path: string, body: Record<string, unknown>, purpose?: "policy" | "move") {
    setBusy(true);
    setProblem(null);
    try {
      const result = await act(path, {
        ...body,
        ...(purpose ? { key: purpose === "policy" ? policyKey : moveKey } : {}),
      });
      if (!result.ok) setProblem(result.why);
      else {
        read.refresh();
        if (purpose === "move") {
          allocation.refresh();
          setMoveAccepted(true);
          setTaskId(null);
        }
      }
    } finally {
      setBusy(false);
      if (purpose === "policy") setPolicyKey("");
      if (purpose === "move") setMoveKey("");
    }
  }
  if (read.error)
    return (
      <p className="p-4 text-sm text-warning">
        Shared registry is unavailable. {read.error} Ownership has not been verified.
      </p>
    );
  if (!view) return <p className="p-4 text-sm text-muted-foreground">Reading shared boards...</p>;
  if (!view.enabled)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Shared boards are not configured for this environment. Local boards still work.
      </p>
    );
  const allocationPanel = chosen ? (
    <>
      <p className="my-2 text-xs text-muted-foreground">
        Owned by {chosen.owner}. A move waits for the source to stop working and the destination to
        confirm receipt. Approval does not travel.
      </p>
      {moveAccepted ? (
        <p role="status" className="my-2 text-xs">
          Move action accepted. Refreshing shared ownership.
        </p>
      ) : null}
      <Input
        aria-label="Approval key for task move"
        type="password"
        autoComplete="off"
        value={moveKey}
        onChange={(e) => setMoveKey(e.target.value)}
      />
      {currentMove ? (
        <div className="mt-3 space-y-2 rounded border p-2 text-xs">
          <p role="status">
            Move {currentMove.state}: {currentMove.source} to {currentMove.destination}.
          </p>
          {canCancelMove ? (
            <>
              <p className="text-muted-foreground">
                The engine confirms whether cancellation is still safe. A task already received
                cannot be cancelled.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !moveKey || moveAccepted}
                onClick={() => {
                  void run(`/api/shared/moves/${currentMove.id}/cancel`, {}, "move");
                }}
              >
                Cancel move
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {allocation.error ? <p className="text-xs text-warning">{allocation.error}</p> : null}
      <div className="mt-3 space-y-2">
        {choices
          .filter((c) => c.machine !== chosen.owner)
          .map((c) => (
            <div key={c.machine} className="rounded border p-2 text-xs">
              <Button
                size="sm"
                disabled={busy || !moveKey || !c.eligible || Boolean(chosen.moving) || moveAccepted}
                onClick={() => {
                  void run(
                    "/api/shared/moves",
                    { task: chosen.id, destination: c.machine },
                    "move",
                  );
                }}
              >
                {c.machine === view.machine ? "Move here" : `Send to ${c.machine}`}
              </Button>
              <p className="mt-1 text-muted-foreground">
                {c.reasons.join(" ") || "Ready for this task."}
              </p>
            </div>
          ))}
      </div>
      {problem ? (
        <p role="alert" className="mt-2 text-xs text-warning">
          {problem}
        </p>
      ) : null}
    </>
  ) : (
    <p className="text-sm text-muted-foreground">
      This task is not in the shared registry. Refresh shared boards after registering it for this
      environment.
    </p>
  );
  if (props.taskId) return allocationPanel;
  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3"
      aria-label="Shared boards"
    >
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Shared board"
          className="max-w-48 rounded border bg-background p-1 text-sm"
          value={boardId}
          onChange={(e) => {
            setBoardId(e.target.value);
            setPolicyKey("");
          }}
        >
          <option value="">All shared boards</option>
          {view.boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>
        <Input
          aria-label="Search shared tasks"
          placeholder="Search shared tasks"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-24 flex-1"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            void run("/api/shared/sync", {});
          }}
        >
          Refresh
        </Button>
      </div>
      {view.problem ? (
        <p role="status" className="text-xs text-warning">
          {view.problem}
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="text-xs text-warning">
          {problem}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {view.machines.length ? `${view.machines.map((m) => m.name || m.id).join(" · ")} · ` : ""}
        Connected through {view.machine}
      </p>
      {board ? (
        <details
          className="rounded border p-2 text-xs"
          onToggle={(event) => {
            if (!event.currentTarget.open) setPolicyKey("");
          }}
        >
          <summary className="cursor-pointer">Allocation policy</summary>
          <p className="py-2">
            {board.policy.automatic ? "Automatic allocation" : "Manual allocation"}. Arriving tasks{" "}
            {board.policy.startOnArrival ? "can resume ready work" : "stay paused"}.
          </p>
          <Input
            aria-label="Approval key for board policy"
            type="password"
            value={policyKey}
            onChange={(e) => setPolicyKey(e.target.value)}
            autoComplete="off"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || !policyKey}
              onClick={() => {
                void run(
                  "/api/shared/boards",
                  { ...board, policy: { ...board.policy, automatic: !board.policy.automatic } },
                  "policy",
                );
              }}
            >
              Use {board.policy.automatic ? "manual" : "automatic"} allocation
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !policyKey}
              onClick={() => {
                void run(
                  "/api/shared/boards",
                  {
                    ...board,
                    policy: { ...board.policy, startOnArrival: !board.policy.startOnArrival },
                  },
                  "policy",
                );
              }}
            >
              {board.policy.startOnArrival ? "Pause arrivals" : "Allow ready arrivals to resume"}
            </Button>
          </div>
        </details>
      ) : null}
      <div className="flex min-h-0 gap-3 overflow-x-auto pb-2">
        {sharedLanes(tasks).map((lane) => (
          <div key={lane.id} className="w-64 shrink-0 space-y-2">
            <h2 className="text-xs font-medium capitalize">
              {lane.id.replaceAll("-", " ")} ({lane.cards.length})
            </h2>
            {lane.cards.map((task) => (
              <article key={task.id} className="space-y-2 rounded border bg-card p-2 text-xs">
                <p className="font-medium break-words">{task.title}</p>
                <p className="text-muted-foreground">
                  #{task.number} · {task.owner}
                </p>
                {task.moving ? (
                  <p role="status">
                    Moving: {view.moves.find((m) => m.id === task.moving)?.state ?? "waiting"}
                  </p>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setTaskId(task.id);
                    setMoveKey("");
                    setMoveAccepted(false);
                    setProblem(null);
                  }}
                >
                  {task.moving ? "Move details" : "Allocate"}
                </Button>
                {task.owner === view.machine && !task.moving && props.onOpen ? (
                  <Button size="sm" variant="ghost" onClick={() => props.onOpen?.(task.id)}>
                    Open task
                  </Button>
                ) : null}
              </article>
            ))}
          </div>
        ))}
      </div>
      {!tasks.length ? (
        <p className="text-sm text-muted-foreground">No matching shared tasks.</p>
      ) : null}
      <Dialog
        open={Boolean(taskId)}
        onOpenChange={(open) => {
          if (!open) {
            setTaskId(null);
            setMoveKey("");
            setProblem(null);
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {chosen
                ? `${chosen.moving ? "Move details for" : "Allocate"} ${chosen.title}`
                : "Task allocation"}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>{allocationPanel}</DialogPanel>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
function SharedTaskAllocationContent(props: {
  environmentId: EnvironmentId | null;
  taskId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Allocate
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Task allocation</DialogTitle>
          </DialogHeader>
          <DialogPanel>{open ? <SharedBoard {...props} /> : null}</DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

export function SharedTaskAllocation(props: {
  environmentId: EnvironmentId | null;
  taskId: string;
}) {
  return <SharedTaskAllocationContent key={`${props.environmentId}:${props.taskId}`} {...props} />;
}
