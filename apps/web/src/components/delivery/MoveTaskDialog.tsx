import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { parseRepositories, type TaskView } from "../../lib/delivery";
import {
  deliveryRemoteOf,
  eligibleMoveBases,
  moveOutcomeLine,
  relocateBody,
  type MoveBoard,
} from "../../lib/deliveryMove";
import { useDeliveryAct, useDeliveryRead, usePersonName } from "../../state/delivery";
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
import { usePaginatedBranches } from "../../state/queries";
import { MOVE_BRANCH_VISIBLE_ROWS, MoveTaskBaseBranchPicker } from "./MoveTaskDialog.branches";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/**
 * Moves a task to a board done in another repository. The engine sets where its work is done
 * from the board and, unless it is a draft, sends it back to triage there.
 */
export function MoveTaskDialog(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: TaskView;
  readonly boards: ReadonlyArray<MoveBoard>;
  /** The board chosen first: the one picked on the task, or the one triage suggests. */
  readonly board: string;
  readonly onClose: () => void;
  readonly onMoved: () => void;
}) {
  const { task } = props;
  const act = useDeliveryAct(props.environmentId, "task relocate");
  const person = usePersonName();
  const [board, setBoard] = useState(props.board);
  const [selection, setSelection] = useState<{ key: string; base: string } | null>(null);
  const repositories = useDeliveryRead(props.environmentId, "/api/repositories");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = props.boards.find((item) => item.id === board) ?? null;
  const repository = parseRepositories(repositories.body).find(
    (entry) => entry.id === chosen?.target?.repository,
  );
  const cwd = repository?.path || chosen?.target?.path || null;
  const remote = deliveryRemoteOf(repository);
  const key = JSON.stringify([props.environmentId, board, chosen?.target?.repository, cwd]);
  const branches = usePaginatedBranches({ environmentId: props.environmentId, cwd, query: "" });
  const eligible = eligibleMoveBases(branches.refs, remote);
  const boardBase = chosen?.target?.base ?? null;
  const listed = boardBase !== null && eligible.includes(boardBase);
  const hasNext = branches.data?.nextCursor != null;
  const exhausted = branches.data !== null && !hasNext && !branches.isPending;
  const unreachable = !cwd || !!branches.error || branches.data?.isRepo === false;
  const base = selection?.key === key ? selection.base : listed ? boardBase : null;
  const canMove = !!board && !!base && !unreachable;
  useEffect(() => {
    if (
      cwd &&
      hasNext &&
      !branches.error &&
      !branches.isFetchingNextPage &&
      (!listed || eligible.length < MOVE_BRANCH_VISIBLE_ROWS)
    )
      branches.loadNext();
  }, [cwd, hasNext, branches, listed, eligible.length]);
  const to = chosen?.target ? (chosen.target.title ?? chosen.target.repository) : null;
  const from = task.target ? (task.target.title ?? task.target.repository) : null;

  const move = async () => {
    if (!canMove || !base || busy) return;
    setBusy(true);
    setProblem(null);
    const result = await act(
      `/api/tasks/${task.id}/relocate`,
      relocateBody({ board, base, by: person }),
    );
    setBusy(false);
    if (!result.ok) {
      setProblem(result.why);
      return;
    }
    props.onMoved();
    props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup className="max-w-lg" data-move-task>
        <DialogHeader>
          <DialogTitle>Move #{task.number} to another board</DialogTitle>
          <DialogDescription>
            {moveOutcomeLine({ isDraft: task.isDraft, to, from })}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-7 text-sm">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Board</span>
              <Select
                value={board}
                onValueChange={(value) => {
                  if (!value) return;
                  setSelection(null);
                  setBoard(String(value));
                }}
              >
                <SelectTrigger aria-label="Board to move to" data-move-task-board={board}>
                  <SelectValue>{chosen?.title ?? "Choose a board"}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {props.boards.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      <span className="flex flex-col">
                        <span>{item.title}</span>
                        <span className="text-2xs text-muted-foreground">
                          {item.target?.repository
                            ? `${item.target.title ?? item.target.repository} · ${item.target.base ?? "its checkout"}`
                            : "No repository set"}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Base branch</span>
              <MoveTaskBaseBranchPicker
                key={key}
                ref={null}
                environmentId={props.environmentId}
                cwd={cwd}
                branches={branches}
                deliveryRemote={remote}
                defaultBase={listed ? boardBase : null}
                value={base ?? ""}
                disabled={busy || !cwd}
                onChange={(base) => setSelection({ key, base })}
              />
              <span className="text-2xs text-muted-foreground">
                Choose a listed branch to start the task's work from.
              </span>
              {exhausted && boardBase && !listed ? (
                <p data-move-task-base-missing>
                  The board's base branch "{boardBase}" is missing from this repository.
                </p>
              ) : null}
              {exhausted && eligible.length === 0 ? (
                <p>No branches are available for this repository.</p>
              ) : null}
              {unreachable ? (
                <p data-move-task-base-unreachable>
                  {branches.error ??
                    (cwd
                      ? "This folder is not a git repository."
                      : "No reachable repository folder is configured.")}
                </p>
              ) : null}
              {repositories.error ? <p>{repositories.error}</p> : null}
              {chosen?.target?.ok === false ? <p>{chosen.target.problem}</p> : null}
            </div>
            {problem ? (
              <p className="text-xs text-destructive" role="alert" data-move-task-problem>
                {problem}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !canMove} onClick={() => void move()} data-move-task-confirm>
            {busy ? "Moving" : "Move"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
