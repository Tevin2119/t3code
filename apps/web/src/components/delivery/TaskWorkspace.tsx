import type { EnvironmentId } from "@t3tools/contracts";
import { boardTaskFinishedBy } from "@t3tools/shared/boardTaskFinished";
import { useGT } from "gt-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { parseTask } from "../../lib/delivery";
import { deliveryReadDiagnostic } from "../../lib/deliveryStates";
import { useDeliveryAct, usePersonName } from "../../state/delivery";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Empty, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset, useSidebar } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BoardTaskContext } from "./BoardTaskContext";
import { DeliveryDiagnosticNotice } from "./DeliveryDiagnosticNotice";
import { SharedTaskAllocation } from "./SharedBoard";
import { TaskConversation } from "./TaskConversation";
import { TaskEditor } from "./TaskEditor";
import { TaskMenu } from "./TaskMenu";
import { TaskPanelTab } from "./TaskPanelTab";
import { TaskWorkspacePanels } from "./TaskWorkspacePanels";
import { useBoardTaskValue } from "./useBoardTaskValue";

/**
 * A board task opened as its native thread: the thread view T3 shows any thread in, with the
 * task's menu in its header, or the native page with the task's words while it has no thread. A
 * draft has the same page, with the task editor as its centre. The task's facts are in the
 * board's left column, which reads the same task. The board's own read is the only source.
 */
export function TaskWorkspace(props: {
  readonly environmentId: EnvironmentId | null;
  readonly taskId: string;
  readonly from: "Board" | "Orchestrator";
  readonly onClose: () => void;
  readonly onOpenTask: (taskId: string | null) => void;
}) {
  const gt = useGT();
  const person = usePersonName();
  const sidebar = useSidebar();
  // This view keeps the task fresh; the board's column reads the same reading.
  const { board, task, read, actions, conversation, owner, others } = useBoardTaskValue(
    props.environmentId,
    props.taskId,
    { polls: true, onOpenTask: props.onOpenTask, onDiscarded: props.onClose },
  );
  const act = useDeliveryAct(props.environmentId, "task seen");
  const steerAct = useDeliveryAct(props.environmentId, "steer");
  const [taskBrief, setTaskBrief] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [createProblem, setCreateProblem] = useState<string | null>(null);
  const [allocatingTask, setAllocatingTask] = useState<string | null>(null);
  const [menuProblem, setMenuProblem] = useState<string | null>(null);

  // Opened and looked at, what the team said is read.
  const unread = task?.card.unread ?? 0;
  const seenFor = useRef<string | null>(null);
  useEffect(() => {
    if (!task || task.isDraft) return;
    const key = `${task.id}:${task.timeline.length}`;
    if (unread === 0 || seenFor.current === key) return;
    if (document.visibilityState !== "visible") return;
    seenFor.current = key;
    void act(`/api/tasks/${task.id}/seen`, { by: person });
  }, [act, person, task, unread]);

  // A finished task takes no turns. What is written to it goes to the engine, which says why not.
  const finished = task !== null && boardTaskFinishedBy(task) !== null;
  const steer = async (text: string) => {
    if (!task) return false;
    const result = await steerAct(`/api/tasks/${task.id}/steer`, { text, seat: null, by: person });
    if (result.ok) read.refresh();
    else
      toastManager.add({
        type: "error",
        title: gt("The task did not take your message"),
        description: result.why,
      });
    return result.ok;
  };
  const problem = actions.problem ?? menuProblem;
  // Under the native header: the engine's notices and the last refusal.
  const notices = (
    <>
      {read.error ? (
        deliveryReadDiagnostic(read.failure, { task: true }) === "unreachable" ? (
          <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-warning">
            Delivery engine not reachable. {read.error} This is not an ordinary chat and it will not
            answer as one.
          </p>
        ) : (
          <DeliveryDiagnosticNotice
            className="min-w-0 shrink-0 space-y-0.5 border-b border-border px-3 py-1.5 text-xs"
            code={deliveryReadDiagnostic(read.failure, { task: true })}
            problem={read.error}
          />
        )
      ) : null}
      {problem ? (
        <p
          className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-warning"
          data-delivery-problem
        >
          {problem}
        </p>
      ) : null}
    </>
  );

  return (
    <BoardTaskContext value={board}>
      <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-task-workspace={props.taskId}>
          {task ? (
            <TaskWorkspacePanels
              key={`${props.environmentId}:${task.id}`}
              owner={owner}
              thread={conversation.ref}
              renderConversation={(panel) => (
                <TaskConversation
                  key={task.id}
                  task={task}
                  state={conversation.state}
                  draft={
                    task.isDraft ? (
                      <TaskEditor
                        framed
                        environmentId={props.environmentId}
                        taskId={task.id}
                        from={props.from}
                        onClose={props.onClose}
                        onSaved={(id) => props.onOpenTask(id)}
                      />
                    ) : undefined
                  }
                  chrome={{
                    actions: (
                      <TaskMenu
                        environmentId={props.environmentId}
                        task={task}
                        actions={others}
                        taskActions={actions}
                        onCreateTask={() => {
                          setCreateProblem(null);
                          setTaskBrief("");
                        }}
                        onAllocate={() => setAllocatingTask(task.id)}
                        onChanged={read.refresh}
                        onProblem={setMenuProblem}
                      />
                    ),
                    notices,
                    panelControls: panel.controls,
                    showLog: () => {
                      // The log is among the task's facts in the board's column, a sheet on a phone.
                      if (sidebar.isMobile) sidebar.setOpenMobile(true);
                      else sidebar.setOpen(true);
                      requestAnimationFrame(() =>
                        document
                          .querySelector('[data-board-panel] [data-task-section="log"]')
                          ?.scrollIntoView({ block: "start", behavior: "smooth" }),
                      );
                    },
                    steer: finished ? steer : undefined,
                    backToBoard: props.onClose,
                  }}
                />
              )}
              deployments={<TaskPanelTab kind="task-deployments" />}
              evidence={<TaskPanelTab kind="task-evidence" />}
            />
          ) : (
            <TaskEmpty notices={notices} reading={read.isPending} failed={!!read.error} />
          )}
        </div>
        {actions.dialog}
        {task ? (
          <SharedTaskAllocation
            environmentId={props.environmentId}
            taskId={task.id}
            open={allocatingTask === task.id}
            onOpenChange={(open) => setAllocatingTask(open ? task.id : null)}
          />
        ) : null}
        <Dialog
          open={taskBrief !== null}
          onOpenChange={(open) => {
            if (!open && !creatingTask) setTaskBrief(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Create a non-code task</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  Write the agreed brief. The draft keeps this conversation, project folder and
                  attachments. Creating it does not start work.
                </p>
                <Textarea
                  aria-label="Agreed task brief"
                  value={taskBrief ?? ""}
                  disabled={creatingTask}
                  onChange={(event) => setTaskBrief(event.target.value)}
                />
                {createProblem ? <p role="alert">{createProblem}</p> : null}
                <Button
                  disabled={creatingTask || !taskBrief?.trim() || !task}
                  onClick={() => {
                    if (!task || !taskBrief?.trim() || creatingTask) return;
                    setCreatingTask(true);
                    void act(`/api/tasks/${task.id}/from-chat`, {
                      text: taskBrief,
                      by: person,
                    }).then((result) => {
                      setCreatingTask(false);
                      if (!result.ok) {
                        setCreateProblem(result.why);
                        return;
                      }
                      const created = parseTask(result.body);
                      if (!created) {
                        setCreateProblem("The engine did not return a task draft.");
                        return;
                      }
                      setTaskBrief(null);
                      read.refresh();
                      props.onOpenTask(created.id);
                    });
                  }}
                >
                  {creatingTask ? "Creating draft..." : "Create draft"}
                </Button>
              </div>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      </SidebarInset>
    </BoardTaskContext>
  );
}

/** No task to show yet, or none by that id: the native empty state under the native header. */
function TaskEmpty(props: {
  readonly notices: ReactNode;
  readonly reading: boolean;
  readonly failed: boolean;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <WorkspacePageHeader electron={isElectron} />
      {props.notices}
      {props.failed ? null : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {props.reading ? "Reading the task." : "There is no such task."}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
