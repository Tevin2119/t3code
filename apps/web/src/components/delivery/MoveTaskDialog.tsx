import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import type { TaskView } from "../../lib/delivery";
import { moveOutcomeLine, relocateBody, type MoveBoard } from "../../lib/deliveryMove";
import { useDeliveryAct, usePersonName } from "../../state/delivery";
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
import { Input } from "../ui/input";
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
  /** A base branch to start from; empty means the board's own. */
  readonly base: string | null;
  readonly onClose: () => void;
  readonly onMoved: () => void;
}) {
  const { task } = props;
  const act = useDeliveryAct(props.environmentId, "task relocate");
  const person = usePersonName();
  const [board, setBoard] = useState(props.board);
  const [base, setBase] = useState(props.base ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = props.boards.find((item) => item.id === board) ?? null;
  const to = chosen?.target ? (chosen.target.title ?? chosen.target.repository) : null;
  const from = task.target ? (task.target.title ?? task.target.repository) : null;

  const move = async () => {
    if (!board || busy) return;
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
        <DialogPanel className="flex flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Board</span>
            <Select value={board} onValueChange={(value) => value && setBoard(String(value))}>
              <SelectTrigger aria-label="Board to move to" data-move-task-board={board}>
                <SelectValue>{chosen?.title ?? "Choose a board"}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {props.boards.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    <span className="flex flex-col">
                      <span>{item.title}</span>
                      <span className="text-[11px] text-muted-foreground">
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
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Base branch</span>
            <Input
              aria-label="Base branch"
              placeholder={chosen?.target?.base ?? "The board's own"}
              value={base}
              onChange={(event) => setBase(event.target.value)}
              data-move-task-base
            />
            <span className="text-[11px] text-muted-foreground">
              Left empty, it starts from the board's own base branch.
            </span>
          </label>
          {problem ? (
            <p className="text-xs text-destructive" role="alert" data-move-task-problem>
              {problem}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !board} onClick={() => void move()} data-move-task-confirm>
            {busy ? "Moving" : "Move"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
