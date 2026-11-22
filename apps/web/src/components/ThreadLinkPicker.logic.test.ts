import { expect, it } from "vite-plus/test";

import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { threadLinkCandidates, threadLinkMatcher } from "./ThreadLinkPicker.logic";

it.each([
  ["cafe", "Café planning", undefined],
  ["café", "Café planning", undefined],
  ["ışık", "Işık planı", "tr-TR"],
])("matches %s against %s", (query, text, locale) => {
  expect(threadLinkMatcher(query, locale)(text)).toBe(true);
});

it("offers the environment's active threads newest first, never server-owned work", () => {
  const environmentId = EnvironmentId.make("env-a");
  const projectId = ProjectId.make("project-a");
  const thread = (id: string, updatedAt: string, more: object = {}) => ({
    id: ThreadId.make(id),
    environmentId,
    projectId,
    title: `Thread ${id}`,
    archivedAt: null,
    updatedAt,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    ...more,
  });
  const candidates = threadLinkCandidates(
    [
      thread("older", "2026-11-01T00:00:00.000Z"),
      thread("newer", "2026-11-02T00:00:00.000Z"),
      thread("archived", "2026-11-03T00:00:00.000Z", { archivedAt: "2026-11-03T00:00:00.000Z" }),
      thread("elsewhere", "2026-11-03T00:00:00.000Z", {
        environmentId: EnvironmentId.make("env-b"),
      }),
      thread("board-task", "2026-11-03T00:00:00.000Z", {
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: ThreadId.make("board-task"),
          engineIntake: "board-task:board-1:task-7",
        },
      }),
    ],
    environmentId,
    new Map([[projectId, "Web"]]),
    "web",
  );
  expect(candidates.map((candidate) => candidate.id)).toEqual(["newer", "older"]);
});
