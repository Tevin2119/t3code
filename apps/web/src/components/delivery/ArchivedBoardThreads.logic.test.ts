import { ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { archivedThreadsOfBoard } from "./ArchivedBoardThreads.logic";

const thread = (board: string, taskId: string, archivedAt: string) => ({
  threadId: ThreadId.make(`thread-${taskId}`),
  projectId: ProjectId.make("project"),
  title: taskId,
  archivedAt,
  board,
  taskId,
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
