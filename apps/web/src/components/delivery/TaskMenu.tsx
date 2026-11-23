import type { EnvironmentId } from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { parseTarget, type TaskView } from "../../lib/delivery";
import { BOARD_LANES, boardLaneOf } from "../../lib/boardLanes";
import { boardMoveIntent, LANE_TITLE } from "../../lib/deliveryBoard";
import { boardChoiceKind, type MoveBoard } from "../../lib/deliveryMove";
import { cn } from "../../lib/utils";
import { useDeliveryAct, useDeliveryRead, usePersonName } from "../../state/delivery";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuItemDetail,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { MoveTaskDialog } from "./MoveTaskDialog";
import { actionHelp, actionLabel, type useTaskActions } from "./taskActions";
import { laneTone } from "./taskParts";

function Action(props: {
  readonly label: ReactNode;
  readonly help: ReactNode;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly [data: `data-${string}`]: string;
}) {
  const { label, help, ...item } = props;
  return (
    <MenuItem {...item}>
      <span className="flex max-w-80 flex-col">
        <span>{label}</span>
        <span className="text-xs text-muted-foreground">{help}</span>
      </span>
    </MenuItem>
  );
}

/**
 * Everything that can be done with the task, each with what it does, in the native header's
 * right-hand actions. The decisions are not here: they are in the lane above the composer.
 */
export function TaskMenu(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: TaskView;
  readonly actions: ReadonlyArray<string>;
  readonly taskActions: Pick<ReturnType<typeof useTaskActions>, "busy" | "run" | "moveTo">;
  readonly onCreateTask: () => void;
  readonly onAllocate: () => void;
  readonly onChanged: () => void;
  /** Why a board move was refused, for the line under the header; null clears it. */
  readonly onProblem: (why: string | null) => void;
}) {
  const { task, taskActions } = props;
  const { card } = task;
  const person = usePersonName();
  const act = useDeliveryAct(props.environmentId, "task edit");
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  // The boards of the person's own, read only while they can be chosen.
  const boardsRead = useDeliveryRead(
    props.environmentId,
    open || moving !== null ? "/api/boards" : null,
  );
  const boards: ReadonlyArray<MoveBoard> = (
    Array.isArray(boardsRead.body) ? boardsRead.body : []
  ).flatMap((item: unknown) =>
    item && typeof item === "object" && "id" in item && "title" in item
      ? [
          {
            id: String(item.id),
            title: String(item.title),
            target: "target" in item ? parseTarget(item.target) : null,
          },
        ]
      : [],
  );
  // The board triage thinks the task belongs on.
  const suggested = task.suggestedBoard ?? card.suggestedBoard ?? null;
  const chooseBoard = (id: string | null) => {
    if (id === card.set) return;
    const chosen = id === null ? null : (boards.find((item) => item.id === id) ?? null);
    // A board done in another repository moves the task's work there, which is confirmed first.
    if (
      id !== null &&
      !["chat", "non-code"].includes(task.workflow) &&
      boardChoiceKind(task.target?.repository ?? null, chosen) === "move"
    ) {
      setMoving(id);
      return;
    }
    props.onProblem(null);
    void act(`/api/tasks/${task.id}/board`, { board: id, by: person }).then((result) => {
      if (!result.ok) props.onProblem(result.why);
      props.onChanged();
    });
  };
  const here = boardLaneOf(task.lane ?? "");
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="What can be done with this task"
              data-task-actions
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          {task.workflow === "chat" && task.state === "chat" ? (
            <Action
              disabled={taskActions.busy}
              onClick={props.onCreateTask}
              label="Create task from chat"
              help="Make this chat a task; nothing starts yet."
            />
          ) : null}
          <Action
            disabled={taskActions.busy}
            onClick={props.onAllocate}
            label="Allocate"
            help="Choose the machine for it, or follow its move."
          />
          {props.actions.map((action) => (
            <Action
              key={action}
              disabled={taskActions.busy}
              onClick={() => taskActions.run(card, action)}
              label={actionLabel(action, card)}
              help={actionHelp(action, card)}
              data-task-menu-action={action}
            />
          ))}
          <MenuSeparator />
          {suggested && suggested.id !== card.set ? (
            <Action
              onClick={() => setMoving(suggested.id)}
              label={
                <>
                  Triage suggests board <span className="font-medium">{suggested.title}</span>
                  {suggested.repositoryTitle ? ` (${suggested.repositoryTitle})` : ""}
                </>
              }
              help="Move..."
              data-task-suggested-board={suggested.id}
            />
          ) : null}
          {!task.isDraft && task.lane ? (
            <MenuSub>
              <MenuSubTrigger disabled={taskActions.busy} data-task-lane={task.lane}>
                <span>Column</span>
                <MenuItemDetail>{LANE_TITLE[here] ?? task.state}</MenuItemDetail>
              </MenuSubTrigger>
              <MenuSubPopup>
                {BOARD_LANES.filter((item) => item.id !== "draft" && item.id !== "closed-not-done")
                  .map((item) => [item.id, LANE_TITLE[item.id] ?? item.id] as const)
                  .map(([lane, title]) => {
                    const intent = boardMoveIntent(card, lane).intent;
                    // What choosing it does, or why it cannot be chosen, is said to every reader.
                    const said =
                      intent.kind === "refused"
                        ? intent.why
                        : intent.kind === "action"
                          ? actionLabel(intent.action, card)
                          : lane === here
                            ? "Here now"
                            : intent.label;
                    return (
                      <Action
                        key={lane}
                        disabled={lane === here}
                        onClick={() =>
                          taskActions.moveTo(card, boardMoveIntent(card, lane).lane, null)
                        }
                        label={
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5",
                              intent.kind === "refused" && "text-muted-foreground",
                            )}
                          >
                            <span className={cn("size-2 rounded-full", laneTone(lane).bar)} />
                            {title}
                          </span>
                        }
                        help={
                          lane !== here && intent.kind === "refused"
                            ? "not from here, choose to see why"
                            : said
                        }
                        data-move={intent.kind}
                      />
                    );
                  })}
              </MenuSubPopup>
            </MenuSub>
          ) : null}
          {card.set === "qualification" ? null : (
            <MenuSub>
              <MenuSubTrigger data-task-board={card.set ?? ""}>
                <span>Board</span>
                <MenuItemDetail>
                  {boards.find((item) => item.id === card.set)?.title ??
                    (card.set ? card.set : "Not on a board")}
                </MenuItemDetail>
              </MenuSubTrigger>
              <MenuSubPopup>
                <MenuItem disabled={card.set === null} onClick={() => chooseBoard(null)}>
                  Not on a board
                </MenuItem>
                {boards.map((item) => (
                  <MenuItem
                    key={item.id}
                    disabled={item.id === card.set}
                    onClick={() => chooseBoard(item.id)}
                  >
                    {item.title}
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          )}
        </MenuPopup>
      </Menu>
      {moving ? (
        <MoveTaskDialog
          environmentId={props.environmentId}
          task={task}
          boards={boards}
          board={moving}
          onClose={() => setMoving(null)}
          onMoved={props.onChanged}
        />
      ) : null}
    </>
  );
}
