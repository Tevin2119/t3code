import { useGT } from "gt-react";

import type { TaskView } from "../../lib/delivery";
import { useBoardTask, type BoardTask } from "./BoardTaskContext";
import { BoardDelivery } from "./BoardDelivery";
import { CardDeliveryStatus } from "./CardDeliveryStatus";
import { MergePermissionControls, MergePermissionSummary } from "./MergePermissionControls";
import { TaskDeploymentsPanel } from "./TaskDeploymentStatus";
import { TaskDisclosure } from "./TaskDisclosure";
import { Info } from "./TaskInfo";
import { PublicationRows } from "./taskParts";

/** The Deployment tab: delivering the task, its pull request, merge permission and deployments. */
function Deployment(props: { readonly board: BoardTask; readonly task: TaskView }) {
  const gt = useGT();
  const { board, task } = props;
  const { environmentId } = board;
  return (
    <div className="flex min-w-0 flex-col gap-2 p-4" data-task-deployment>
      {/* A task filed from a thread here is delivered from here. */}
      {environmentId && task.origin.startsWith(`thread:${environmentId}/`) ? (
        <BoardDelivery
          key={`${environmentId}:${task.id}`}
          environmentId={environmentId}
          task={{
            id: task.id,
            origin: task.origin,
            held: task.held,
            state: task.state,
            repository: task.target?.repository ?? null,
            base: task.target?.base ?? null,
          }}
        />
      ) : null}
      <TaskDisclosure title={gt("Pull request")}>
        {task.publications.length > 0 || task.state === "approved" ? (
          <div className="flex flex-col gap-2" data-task-publication>
            <PublicationRows task={task} />
          </div>
        ) : null}
        <CardDeliveryStatus card={task.card} variant="panel" />
      </TaskDisclosure>
      <TaskDisclosure title="Automatic merge permission">
        {/* The controls say what is set; without an environment to change it in, the summary does. */}
        {environmentId ? (
          <MergePermissionControls
            environmentId={environmentId}
            path={`/api/tasks/${task.id}/merge-permission`}
            policy={task.card.mergePermission}
            stale={board.stale}
            onDone={board.refresh}
            untitled
          />
        ) : (
          <div data-task-merge-summary>
            <MergePermissionSummary policy={task.card.mergePermission} />
          </div>
        )}
      </TaskDisclosure>
      <TaskDisclosure title={gt("Deployments")}>
        <TaskDeploymentsPanel card={task.card} stale={board.stale} />
      </TaskDisclosure>
    </div>
  );
}

/**
 * A board task's tab, on its thread's right panel or on the task's own panel while it has no
 * thread: one scroll, with sections that fold. Without a board task here it shows nothing, so an
 * ordinary thread that somehow kept the tab gets an empty one.
 */
export function TaskPanelTab(props: { readonly kind: "task-evidence" | "task-deployments" }) {
  const board = useBoardTask();
  if (!board?.task) return null;
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
      data-task-panel-tab={props.kind}
    >
      {props.kind === "task-evidence" ? (
        <Info
          key={board.task.id}
          environmentId={board.environmentId}
          task={board.task}
          onChanged={board.refresh}
        />
      ) : (
        <Deployment board={board} task={board.task} />
      )}
    </div>
  );
}
