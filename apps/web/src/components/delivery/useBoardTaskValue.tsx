import type { EnvironmentId } from "@t3tools/contracts";
import { createContext, useContext, type ReactNode } from "react";

import { parseTask } from "../../lib/delivery";
import { taskPanelRef, useRightPanelStore } from "../../rightPanelStore";
import { useDeliveryRead, useStaleReading } from "../../state/delivery";
import type { BoardTask } from "./BoardTaskContext";
import { DecisionBar } from "./DecisionBar";
import { useTaskActions } from "./taskActions";
import { useTaskConversation } from "./useTaskConversation";
import { useTaskSideChat } from "./useTaskSideChat";

const PRIMARY_ACTIONS = ["approve", "reject", "publish", "submit", "deliver", "accept-artifacts"];

/**
 * One board task as both its views read it: the board's left column with its facts, and the
 * workspace with its thread. It is built once, by `OpenBoardTaskProvider`, so the task is read on
 * one clock and its actions send one request at a time from either view.
 */
function useBoardTaskValue(
  environmentId: EnvironmentId | null,
  taskId: string | null,
  options: {
    readonly onOpenTask: (taskId: string | null) => void;
    /** After the task was discarded: it is gone, so its view closes. */
    readonly onDiscarded: () => void;
  },
) {
  const read = useDeliveryRead(
    taskId ? environmentId : null,
    taskId ? `/api/tasks/${taskId}` : null,
    { pollMs: 3_000 },
  );
  const parsed = parseTask(read.body);
  // A reading of the task opened before is not this one's.
  const task = parsed && parsed.id === taskId ? parsed : null;
  const stale = useStaleReading(read.readAt);
  const owner = JSON.stringify([environmentId, taskId]);
  const actions = useTaskActions(environmentId, {
    onDone: read.refresh,
    onDiscarded: options.onDiscarded,
    scope: owner,
  });
  const conversation = useTaskConversation(task);
  const discuss = useTaskSideChat(conversation.ref);
  // The task's tabs live on its thread's right panel, or on its own while it has no thread.
  const panelRef = conversation.ref ?? taskPanelRef(owner);
  const primary = task?.actions.filter((action) => PRIMARY_ACTIONS.includes(action)) ?? [];
  const others = task?.actions.filter((action) => !PRIMARY_ACTIONS.includes(action)) ?? [];
  const board: BoardTask | null = taskId
    ? {
        environmentId,
        taskId,
        task,
        stale: stale || !!read.error,
        refresh: read.refresh,
        openTask: options.onOpenTask,
        openTab: (tab) => useRightPanelStore.getState().open(panelRef, tab),
        // A draft's editor carries its own controls, so it has no decisions.
        decisions:
          task && !task.isDraft ? (
            <DecisionBar
              task={task}
              actions={primary}
              busy={actions.busy}
              onAction={(action) => actions.run(task.card, action)}
            />
          ) : null,
        thread: conversation.ref,
        seats: conversation.seats,
        discuss,
      }
    : null;
  return { board, task, read, actions, conversation, owner, panelRef, others, discuss };
}

export type OpenBoardTask = ReturnType<typeof useBoardTaskValue>;

const OpenBoardTaskContext = createContext<OpenBoardTask | null>(null);

/** The open board task, as the column and the workspace share it; null where none is provided. */
export const useOpenBoardTask = () => useContext(OpenBoardTaskContext);

/** Builds the open task once for everything under it, with the one dialog its actions ask in. */
export function OpenBoardTaskProvider(props: {
  readonly environmentId: EnvironmentId | null;
  readonly taskId: string | null;
  readonly onOpenTask: (taskId: string | null) => void;
  readonly onDiscarded: () => void;
  readonly children: ReactNode;
}) {
  const value = useBoardTaskValue(props.environmentId, props.taskId, {
    onOpenTask: props.onOpenTask,
    onDiscarded: props.onDiscarded,
  });
  return (
    <OpenBoardTaskContext value={value}>
      {props.children}
      {value.actions.dialog}
    </OpenBoardTaskContext>
  );
}
