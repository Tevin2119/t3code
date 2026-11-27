import type { DeploymentCompare, EnvironmentId } from "@t3tools/contracts";
import { CopyPlusIcon, SquareKanbanIcon } from "lucide-react";
import { useState } from "react";
import { useBoardStore } from "../../state/deliveryBoard";
import { useDeliveryRead, useFilePort, usePersonName } from "../../state/delivery";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { portableCommitsOf, portBoardsOf, type PortRow } from "./ReleaseLine.logic";

/** A sandbox-only row's Port to app action, or the port already filed for it. */
export function PortSlot({
  row,
  to,
  onPort,
  onTask,
}: {
  row: PortRow;
  to: string;
  onPort: () => void;
  onTask: (task: string) => void;
}) {
  if (row.kind === "filed") {
    const { port } = row;
    return (
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1 text-primary underline-offset-2 hover:underline"
        onClick={() => onTask(port.task)}
        data-release-port="filed"
      >
        <SquareKanbanIcon aria-hidden className="size-3" />
        Port filed{port.number === null ? "" : `: task #${port.number}`}
      </button>
    );
  }
  return (
    <Button size="xs" variant="outline" onClick={onPort} data-release-port="offer">
      <CopyPlusIcon aria-hidden />
      Port to {to}
    </Button>
  );
}

const short = (commit: string) => commit.slice(0, 7);

/**
 * Confirms one Port to app filing: the board it lands on, who files it, and the sandbox-only
 * commits it names. The server composes the task from the engine's reading and stamps its origin.
 */
export function PortDialog({
  environmentId,
  compare,
  repositoryTitle,
  board: preferredBoard,
  onClose,
  onFiled,
}: {
  environmentId: EnvironmentId;
  compare: DeploymentCompare;
  repositoryTitle: string;
  /** The board being viewed, when the release line sits on one. */
  board: string | null;
  onClose: () => void;
  onFiled: () => void;
}) {
  const { from, to, folders } = compare;
  const offered = portableCommitsOf(compare);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(offered.map((row) => row.commit)),
  );
  const boardsRead = useDeliveryRead(environmentId, "/api/boards");
  const boards = portBoardsOf(boardsRead.body, compare.repository);
  const [pickedBoard, setPickedBoard] = useState<string | null>(null);
  const board =
    pickedBoard ??
    (
      boards.find((entry) => entry.id === preferredBoard) ??
      (boards.length === 1 ? boards[0] : null)
    )?.id ??
    null;
  const person = usePersonName();
  const [by, setBy] = useState(person);
  const setPerson = useBoardStore((state) => state.setPerson);
  const port = useFilePort(environmentId);
  const [busy, setBusy] = useState(false);
  const commits = offered.filter((row) => chosen.has(row.commit)).map((row) => row.commit);
  const blocked = !port.allowed || busy || !board || commits.length === 0 || !by.trim();

  const submit = async () => {
    if (blocked) return;
    setBusy(true);
    const result = await port.file({ board, from: from.id, to: to.id, by: by.trim(), commits });
    setBusy(false);
    if (!result.ok) {
      toastManager.add({ type: "error", title: "Port not filed", description: result.why });
      return;
    }
    setPerson(by.trim());
    const { task, created } = result.filing;
    toastManager.add({
      type: "success",
      title: created
        ? `Port filed as task #${task.number}`
        : `Port already filed as task #${task.number}`,
      description: `A draft on ${task.board ?? board}. Start it from the board when it is ready.`,
    });
    onFiled();
    onClose();
  };

  return (
    <AlertDialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Port to {to.environment}</AlertDialogTitle>
          <AlertDialogDescription>
            Files one draft task asking to bring these {folders?.from}/ commits into {folders?.to}/
            with a pull request into {from.branch}, under the normal gates.
          </AlertDialogDescription>
          <div
            className="flex max-h-[60vh] min-w-0 flex-col gap-3 overflow-y-auto pt-2 text-left text-sm"
            data-port-dialog
          >
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Repository</dt>
              <dd className="min-w-0 break-words">{repositoryTitle}</dd>
              <dt className="text-muted-foreground">From</dt>
              <dd className="min-w-0 break-words">
                {from.environment} · {from.branch} · serves {folders?.from}/
              </dd>
              <dt className="text-muted-foreground">To</dt>
              <dd className="min-w-0 break-words">
                {to.environment} · {to.branch} · serves {folders?.to}/
              </dd>
            </dl>
            <fieldset className="flex min-w-0 flex-col gap-1">
              <legend className="mb-1 text-xs font-medium">Commits</legend>
              {offered.map((row) => (
                <label key={row.commit} className="flex min-w-0 items-start gap-2 text-xs">
                  <Checkbox
                    checked={chosen.has(row.commit)}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      setChosen((current) => {
                        const next = new Set(current);
                        if (checked) next.add(row.commit);
                        else next.delete(row.commit);
                        return next;
                      })
                    }
                  />
                  <code className="shrink-0 font-mono text-muted-foreground">
                    {short(row.commit)}
                  </code>
                  <span className="min-w-0 break-words">{row.subject}</span>
                </label>
              ))}
            </fieldset>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs font-medium">Board</span>
              {boardsRead.isPending && !boards.length ? (
                <p className="text-xs text-muted-foreground">Reading boards…</p>
              ) : boards.length === 0 ? (
                <p role="alert" className="text-xs text-warning-foreground">
                  No board does its work in {repositoryTitle}. Point a board at this repository
                  first.
                </p>
              ) : (
                <Select
                  value={board ?? ""}
                  onValueChange={(value) => setPickedBoard(String(value))}
                >
                  <SelectTrigger aria-label="Board" size="compact">
                    <SelectValue>
                      {boards.find((entry) => entry.id === board)?.title ?? "Choose a board"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {boards.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              )}
            </div>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-xs font-medium">Your name</span>
              <Input
                value={by}
                maxLength={60}
                disabled={busy}
                onChange={(event) => setBy(event.target.value)}
                aria-label="Your name"
              />
            </label>
            {!port.allowed ? (
              <p role="status" className="text-xs text-muted-foreground">
                This connection does not have permission to file board tasks.
              </p>
            ) : null}
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
            Cancel
          </AlertDialogClose>
          <Button disabled={blocked} onClick={() => void submit()} data-port-submit>
            {busy ? "Filing…" : "File port task"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
