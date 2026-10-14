import type { TaskBrief } from "../../lib/delivery";

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
