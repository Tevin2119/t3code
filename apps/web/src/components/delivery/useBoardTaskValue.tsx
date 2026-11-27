import type { EnvironmentId } from "@t3tools/contracts";

import { parseTask } from "../../lib/delivery";
import { taskPanelRef, useRightPanelStore } from "../../rightPanelStore";
import { useDeliveryRead, useStaleReading } from "../../state/delivery";
import type { BoardTask } from "./BoardTaskContext";
import { DecisionBar } from "./DecisionBar";
import { useTaskActions } from "./taskActions";
import { useTaskConversation } from "./useTaskConversation";

const PRIMARY_ACTIONS = ["approve", "reject", "publish", "submit", "deliver", "accept-artifacts"];

/**
 * One board task as both its views read it: the board's left column with its facts, and the
 * workspace with its thread. Both read the same engine reading; only the one that `polls` keeps
 * it fresh, so a task open in both is read on one clock.
 */
export function useBoardTaskValue(
  environmentId: EnvironmentId | null,
  taskId: string | null,
  options: {
    readonly polls: boolean;
    readonly onOpenTask: (taskId: string | null) => void;
    /** After the task was discarded from here: it is gone, so its view closes. */
    readonly onDiscarded: () => void;
  },
) {
  const read = useDeliveryRead(
    taskId ? environmentId : null,
    taskId ? `/api/tasks/${taskId}` : null,
    options.polls ? { pollMs: 3_000 } : {},
  );
  const parsed = parseTask(read.body);
  // A reading of the task opened before is not this one's.
  const task = parsed && parsed.id === taskId ? parsed : null;
  const stale = useStaleReading(read.readAt);
  const actions = useTaskActions(environmentId, {
    onDone: read.refresh,
    onDiscarded: options.onDiscarded,
  });
  const conversation = useTaskConversation(task);
  const owner = JSON.stringify([environmentId, taskId]);
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
      }
    : null;
  return { board, task, read, actions, conversation, owner, panelRef, others };
}
