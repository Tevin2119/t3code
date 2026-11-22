import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, ArchiveX, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { deliveryEnvironment } from "../../state/delivery";
import { useEnvironmentQuery } from "../../state/query";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import {
  archivedThreadsOfBoard,
  archivedThreadTaskNote,
  type ArchivedBoardThread,
} from "./ArchivedBoardThreads.logic";

/**
 * The board's door to the conversations of tasks that ended. Such a thread is archived, never
 * deleted, and no thread list shows it, so this is where it is opened, restored or deleted. A
 * restore is offered only where the task can take the thread back.
 */
export function ArchivedBoardThreads(props: {
  readonly environmentId: EnvironmentId;
  /** The open board, or `all` for every board of the environment. */
  readonly board: string;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const [pending, setPending] = useState<string | null>(null);
  // Read while the list is open: an archive is rare, and nothing on the board counts them.
  const query = useEnvironmentQuery(
    open
      ? deliveryEnvironment.archivedBoardThreads({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const threads = archivedThreadsOfBoard(query.data?.threads ?? [], props.board);

  const act = async (action: "restore" | "delete", thread: ArchivedBoardThread) => {
    if (pending !== null) return;
    setPending(thread.threadId);
    const target = scopeThreadRef(props.environmentId, thread.threadId);
    const result = await settlePromise(
      async () =>
        await (action === "restore"
          ? unarchiveThread(target)
          : confirmAndDeleteThread(target, thread.title)),
    );
    setPending(null);
    const failure =
      result._tag === "Failure" ? result : result.value._tag === "Failure" ? result.value : null;
    if (failure) {
      const error = squashAtomCommandFailure(failure);
      toastManager.add({
        type: "error",
        title:
          action === "restore"
            ? "Could not restore the conversation"
            : "Could not delete the conversation",
        description: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    query.refresh();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Archived task conversations"
            data-board-archived-threads
          />
        }
      >
        <ArchiveIcon />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-[28rem] max-w-[calc(100vw-2rem)]">
        <PopoverTitle className="mb-1">Archived task conversations</PopoverTitle>
        <p className="mb-2 text-2xs text-muted-foreground">
          A task that was deleted, or whose project was removed, leaves its conversation here. It is
          in no thread list.
        </p>
        {query.error ? (
          <p className="text-xs text-destructive" data-board-archived-error>
            {query.error}
          </p>
        ) : threads.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-board-archived-empty>
            {query.isPending ? "Loading…" : "No archived conversations on this board."}
          </p>
        ) : (
          <ul className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
            {threads.map((thread) => {
              const note = archivedThreadTaskNote(thread);
              return (
                <li
                  key={thread.threadId}
                  className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
                  data-board-archived-thread={thread.taskId}
                  data-board-archived-task={thread.task}
                >
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className="block max-w-full truncate text-left text-xs font-medium underline-offset-2 hover:underline"
                      onClick={() =>
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: {
                            environmentId: props.environmentId,
                            threadId: thread.threadId,
                          },
                        })
                      }
                    >
                      {thread.title}
                    </button>
                    <p className="truncate text-2xs text-muted-foreground">
                      {props.board === "all" ? `${thread.board} · ` : null}
                      Archived <RelativeTime timestamp={thread.archivedAt} />
                      {note === null ? null : ` · ${note}`}
                    </p>
                  </div>
                  {note === null ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      aria-label={`Restore ${thread.title}`}
                      title="Restore"
                      disabled={pending !== null}
                      onClick={() => void act("restore", thread)}
                    >
                      <ArchiveX className="size-3.5" />
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="destructive-outline"
                    aria-label={`Delete ${thread.title}`}
                    title="Delete"
                    disabled={pending !== null}
                    onClick={() => void act("delete", thread)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverPopup>
    </Popover>
  );
}
