import { useAtomValue } from "@effect/atom-react";
import { isReservedBoardTaskBoard, type ScopedThreadRef } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { SquareKanbanIcon, SquarePlusIcon } from "lucide-react";
import { useState } from "react";

import { taskFromConversation } from "../../lib/deliveryBoard";
import { cn } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { fileThreadTaskDialogAtom, openFileThreadTaskDialog } from "./fileThreadTaskDialogState";
import { useDeliveryEnabled, useDeliveryRead, useFileThreadTask } from "../../state/delivery";
import { useThreadProjection, useThreadShell } from "../../state/entities";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "../chat/threadDetailsPanelStyles";
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
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { taskStandsIn, useThreadTasks, useThreadTasksRead } from "./ThreadTaskLinks";

export function FileThreadTaskDialogHost() {
  const threadRef = useAtomValue(fileThreadTaskDialogAtom);
  if (threadRef === null) return null;
  return (
    <FileThreadTaskDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(fileThreadTaskDialogAtom, null)}
    />
  );
}

/** A person's own boards from `/api/boards`, never the kept views. */
function fileableBoardsOf(
  body: unknown,
): ReadonlyArray<{ readonly id: string; readonly title: string }> {
  return (Array.isArray(body) ? body : []).flatMap((item: unknown) =>
    item &&
    typeof item === "object" &&
    "id" in item &&
    typeof item.id === "string" &&
    !isReservedBoardTaskBoard(item.id)
      ? [{ id: item.id, title: "title" in item ? String(item.title) : item.id }]
      : [],
  );
}

const TITLE_LIMIT = 120;
const BODY_LIMIT = 20_000;

/**
 * Files one draft task from a thread on a board the person picks. The server stamps the thread
 * as its origin; the draft is written from the conversation and the person edits it first.
 */
function FileThreadTaskDialog({
  threadRef,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  onClose: () => void;
}) {
  const { environmentId, threadId } = threadRef;
  const enabled = useDeliveryEnabled(environmentId);
  const shell = useThreadShell(threadRef);
  const detail = useThreadProjection(threadRef);
  const boardsRead = useDeliveryRead(enabled ? environmentId : null, "/api/boards");
  const boards = fileableBoardsOf(boardsRead.body);
  const tasksRead = useThreadTasksRead(environmentId, threadId);
  const filing = useFileThreadTask(environmentId);
  const [pickedBoard, setPickedBoard] = useState<string | null>(null);
  const board = pickedBoard ?? (boards.length === 1 ? boards[0]!.id : null);
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  // Written from the conversation once it has loaded, then the person's to change.
  if (draft === null && shell && detail) {
    const made = taskFromConversation({
      title: shell.title,
      ref: `${environmentId}/${threadId}`,
      messages: detail.projection.messages,
    });
    setDraft({ title: made.title, body: made.text.slice(0, BODY_LIMIT) });
  }
  const [busy, setBusy] = useState(false);
  // A filing that replayed the task this thread already has there: nothing new was saved.
  const [replayed, setReplayed] = useState<{ id: string; number: number } | null>(null);
  const title = draft?.title ?? "";
  const body = draft?.body ?? "";
  const blocked =
    !enabled || !filing.allowed || busy || !board || !title.trim() || !body.trim() || !draft;

  const submit = async () => {
    if (blocked) return;
    setBusy(true);
    const result = await filing.file({ threadId, board, title, body });
    setBusy(false);
    if (!result.ok) {
      toastManager.add({ type: "error", title: "Task not filed", description: result.why });
      return;
    }
    const { task, created } = result.filing;
    tasksRead.refresh();
    if (!created) {
      setReplayed({ id: task.id, number: task.number });
      return;
    }
    toastManager.add({
      type: "success",
      title: `Filed as task #${task.number}`,
      description: `A draft on ${task.board ?? board}. Submit it from the board when it is ready.`,
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogPopup className="max-w-xl" data-file-thread-task-dialog>
        <DialogHeader>
          <DialogTitle>File a task from this thread</DialogTitle>
          <DialogDescription>
            Files a draft on the board you pick. The task links back to this thread, and nothing is
            asked of a team until it is submitted.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {!enabled ? (
            <p role="status" className="text-xs text-muted-foreground">
              Turn on delivery for this environment to file tasks on a board.
            </p>
          ) : (
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs font-medium">Board</span>
              {boardsRead.isPending && !boards.length ? (
                <p className="text-xs text-muted-foreground">Reading boards…</p>
              ) : boards.length === 0 ? (
                <p role="alert" className="text-xs text-warning-foreground">
                  There is no board to file on yet. Make one on the Board first.
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
          )}
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-medium">Title</span>
            <Input
              aria-label="Title"
              value={title}
              maxLength={TITLE_LIMIT}
              readOnly={busy || !draft}
              onChange={(event) => {
                setReplayed(null);
                setDraft({ title: event.target.value, body });
              }}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-medium">What is asked</span>
            <Textarea
              aria-label="What is asked"
              value={body}
              maxLength={BODY_LIMIT}
              rows={10}
              readOnly={busy || !draft}
              placeholder={draft ? undefined : "Reading the conversation…"}
              onChange={(event) => {
                setReplayed(null);
                setDraft({ title, body: event.target.value });
              }}
            />
          </label>
          {replayed ? (
            <p
              role="alert"
              className="text-xs text-warning-foreground"
              data-file-thread-task-replayed
            >
              This thread was already filed on this board as{" "}
              <Link
                to="/board"
                search={{ environment: environmentId, task: replayed.id }}
                className="text-primary underline-offset-2 hover:underline"
                onClick={onClose}
              >
                task #{replayed.number}
              </Link>
              . Nothing new was filed, so the edits here were not saved. Change that task on the
              board instead.
            </p>
          ) : null}
          {enabled && !filing.allowed ? (
            <p role="status" className="text-xs text-muted-foreground">
              This connection does not have permission to file board tasks.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={blocked}
            onClick={() => void submit()}
            data-file-thread-task-submit
          >
            {busy ? "Filing…" : "File draft"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * The details panel's board rows for a plain thread: each task filed from it, linking to that
 * task, then the action that files one. A discarded draft leaves the list, so it can be filed again.
 */
export function ThreadFiledTasks({ threadRef }: { threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const tasks = useThreadTasks(threadRef.environmentId, threadRef.threadId);
  const { allowed } = useFileThreadTask(threadRef.environmentId);
  return (
    <ThreadDetailsSection
      headingId="thread-details-board-heading"
      title="Board"
      showHeading={false}
    >
      <div className="flex flex-col" data-thread-filed-tasks>
        <ul className="m-0 flex list-none flex-col p-0">
          {tasks.map((task) => (
            <li key={task.id}>
              <ThreadDetailsControl
                size="sm"
                variant="ghost"
                part="row"
                onClick={() =>
                  void navigate({
                    to: "/board",
                    search: { environment: threadRef.environmentId, task: task.id },
                  })
                }
                data-thread-filed-task={task.id}
              >
                <SquareKanbanIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
                  Filed as task #{task.number}
                </span>
                <span className="text-2xs font-normal text-muted-foreground">
                  {taskStandsIn(task)}
                </span>
              </ThreadDetailsControl>
            </li>
          ))}
        </ul>
        {allowed ? (
          <ThreadDetailsControl
            size="sm"
            variant="ghost"
            part="row"
            onClick={() => openFileThreadTaskDialog(threadRef)}
            data-file-thread-task
          >
            <SquarePlusIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
              File a task from this thread
            </span>
          </ThreadDetailsControl>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
