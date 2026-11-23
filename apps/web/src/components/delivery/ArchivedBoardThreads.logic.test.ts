import { ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  archivedThreadsOfBoard,
  archivedThreadTarget,
  archivedThreadTaskNote,
} from "./ArchivedBoardThreads.logic";

const thread = (board: string, taskId: string, archivedAt: string) => ({
  threadId: ThreadId.make(`thread-${taskId}`),
  projectId: ProjectId.make("project"),
  title: taskId,
  archivedAt,
  board,
  taskId,
  task: "open" as const,
});

it("lists the open board's archived conversations, newest first, and every board's on all", () => {
  const threads = [
    thread("work", "a", "2026-11-20T10:00:00.000Z"),
    thread("other", "b", "2026-11-22T10:00:00.000Z"),
    thread("work", "c", "2026-11-21T10:00:00.000Z"),
  ];
  expect(archivedThreadsOfBoard(threads, "work").map((entry) => entry.taskId)).toEqual(["c", "a"]);
  expect(archivedThreadsOfBoard(threads, "all").map((entry) => entry.taskId)).toEqual([
    "b",
    "c",
    "a",
  ]);
  expect(archivedThreadsOfBoard(threads, "none")).toEqual([]);
});

it("offers a restore only for a task that can take the thread back, and says why not", () => {
  const row = thread("work", "a", "2026-11-20T10:00:00.000Z");
  // No note is the restore: the row of an open task shows Open, Restore and Delete.
  expect(archivedThreadTaskNote(row)).toBeNull();
  expect(archivedThreadTaskNote({ ...row, task: "deleted" })).toBe("The task was deleted.");
  // An engine that did not answer never offers a restore and never calls the task deleted.
  expect(archivedThreadTaskNote({ ...row, task: "unknown" })).toBe(
    "The task could not be checked.",
  );
  expect(archivedThreadTaskNote({ ...row, task: "held" })).toBe("The task is held elsewhere.");
});

it("opens a restorable task's conversation in the task's view, and a deleted task's on its own", () => {
  const row = thread("work", "task-a", "2026-11-20T10:00:00.000Z");
  // The task comes from what the server serves for the row, never from the thread itself.
  expect(archivedThreadTarget(row)).toEqual({ kind: "task", taskId: "task-a" });
  expect(archivedThreadTarget({ ...row, task: "deleted" })).toEqual({
    kind: "thread",
    threadId: row.threadId,
  });
  // A task held elsewhere or not checked cannot take the thread back, so neither has a view here.
  for (const task of ["held", "unknown"] as const) {
    expect(archivedThreadTarget({ ...row, task })).toEqual({
      kind: "thread",
      threadId: row.threadId,
    });
  }
});
