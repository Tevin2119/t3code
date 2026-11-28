import type { TaskBrief, TaskView } from "../../lib/delivery";
import type { BoardTask } from "./BoardTaskContext";

export function relatedTaskGroups(tasks: ReadonlyArray<TaskBrief>) {
  const historical = tasks.filter(
    (task) =>
      ["rejected", "moved", "superseded"].includes(task.state) ||
      (task.state === "closed" && task.lane !== "completed"),
  );
  const completed = tasks.filter((task) => task.state === "merged" || task.lane === "completed");
  const excluded = new Set([...historical, ...completed].map((task) => task.id));
  const current = tasks.filter((task) => !excluded.has(task.id));
  return { current, completed, historical };
}

/** A parent, parts or QA follow-ups: the board tasks a task's lineage shows beside its agents. */
export const taskHasRelatedTasks = (task: Pick<TaskView, "parent" | "followUps" | "card">) =>
  Boolean(task.parent) || task.card.parts.length > 0 || task.followUps.length > 0;

/** Related tasks, or the conversation the task was made from: what the lineage adds for a task. */
export const taskHasRelatedWork = (
  task: Pick<TaskView, "parent" | "followUps" | "card" | "source">,
) => taskHasRelatedTasks(task) || task.source !== null;

/** Whether a board task adds anything to its thread's lineage: `TaskLineage` renders nothing otherwise. */
export const taskHasLineage = (board: BoardTask | null): board is BoardTask & { task: TaskView } =>
  board?.task != null && (board.seats.rows.length > 0 || taskHasRelatedWork(board.task));
