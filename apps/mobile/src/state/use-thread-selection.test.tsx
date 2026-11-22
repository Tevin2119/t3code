import * as NodeModule from "node:module";

import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import {
  EnvironmentId,
  isListedThreadLineage,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { extractAgentNotificationDeepLink } from "../features/agent-awareness/notificationPayload";
import { scopedThreadKey } from "../lib/scopedEntities";
import { makeRawThreadShell } from "../test-fixtures";

// The environment is stood in for at the two reads the thread route makes: the shell row and the
// thread's own detail. Mobile has no fake socket to drive a whole screen against.
const harness = vi.hoisted(() => ({
  route: { key: "thread", name: "Thread", params: {} as object },
  shell: null as unknown,
  detail: null as unknown,
  detailReads: [] as Array<readonly [string | null, string | null]>,
}));

vi.mock("@react-navigation/native", () => ({ useRoute: () => harness.route }));
vi.mock("./entities", () => ({
  useQuietThreadShell: () => harness.shell,
  useProject: () => null,
}));
vi.mock("./threads", () => ({
  useEnvironmentThread: (environmentId: string | null, threadId: string | null) => {
    harness.detailReads.push([environmentId, threadId]);
    return environmentId === null ? EMPTY_ENVIRONMENT_THREAD_STATE : harness.detail;
  },
}));
vi.mock("./use-thread-outbox", () => ({ useThreadOutboxMessages: () => ({}) }));
vi.mock("./use-remote-environment-registry", () => ({
  useRemoteEnvironmentRuntime: () => null,
  useSavedRemoteConnection: () => null,
}));

import { useThreadSelection } from "./use-thread-selection";

const requireNavigation = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { getStateFromPath } = requireNavigation("@react-navigation/core") as {
  getStateFromPath: typeof import("@react-navigation/native").getStateFromPath;
};

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("board-task-thread");
const boardTask = makeRawThreadShell({
  id: threadId,
  title: "Task 7",
  lineage: {
    rootThreadId: threadId,
    parentThreadId: null,
    relationshipToParent: null,
    engineIntake: "board-task:board-1:task-7",
  },
});

function detailOf(archivedAt: DateTime.Utc | null): OrchestrationV2ThreadProjection {
  return {
    thread: {
      id: boardTask.id,
      projectId: boardTask.projectId,
      title: boardTask.title,
      providerInstanceId: boardTask.providerInstanceId,
      modelSelection: boardTask.modelSelection,
      runtimeMode: boardTask.runtimeMode,
      interactionMode: boardTask.interactionMode,
      branch: boardTask.branch,
      worktreePath: boardTask.worktreePath,
      activeProviderThreadId: boardTask.activeProviderThreadId,
      lineage: boardTask.lineage,
      forkedFrom: boardTask.forkedFrom,
      createdBy: boardTask.createdBy,
      creationSource: boardTask.creationSource,
      createdAt: boardTask.createdAt,
      updatedAt: boardTask.updatedAt,
      archivedAt,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: boardTask.updatedAt,
  };
}

/** The Thread route's params for a link, read with the path `Stack.tsx` gives that route. */
function threadRouteParams(link: string) {
  const state = getStateFromPath(link, {
    screens: { Thread: { path: "threads/:environmentId?/:threadId?" } },
  });
  const route = state?.routes.at(-1);
  if (route?.name !== "Thread") throw new Error(`${link} did not open the thread route`);
  return route.params ?? {};
}

function select() {
  let selection: ReturnType<typeof useThreadSelection> | null = null;
  function Probe() {
    const current = useThreadSelection();
    useLayoutEffect(() => {
      selection = current;
    });
    return null;
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  try {
    act(() => root.render(<Probe />));
    return (selection as ReturnType<typeof useThreadSelection> | null)!;
  } finally {
    act(() => root.unmount());
  }
}

const archivedAt = DateTime.makeUnsafe("2026-11-20T00:00:00.000Z");
const live = { ...EMPTY_ENVIRONMENT_THREAD_STATE, status: "live" as const };

it.each([
  { shell: "left its row out", row: null, detail: detailOf(null), archived: false },
  { shell: "has archived it", row: null, detail: detailOf(archivedAt), archived: true },
  { shell: "got its row as a delta", row: boardTask, detail: null, archived: false },
])("opens a board task's thread from a link by id when the shell $shell", (c) => {
  // The link a notification or another app hands over, as the app itself writes it.
  const link = extractAgentNotificationDeepLink({
    notification: { request: { content: { data: { environmentId, threadId } } } },
  });
  expect(link).toBe("/threads/environment-1/board-task-thread");
  harness.route = { key: "thread", name: "Thread", params: threadRouteParams(link!) };
  harness.shell = c.row === null ? null : { ...c.row, environmentId };
  harness.detail = c.detail === null ? live : { ...live, data: Option.some(c.detail) };
  harness.detailReads = [];

  const { selectedThread } = select();

  // The route screen shows the thread when the selection is the thread the route names.
  expect(selectedThread).not.toBeNull();
  expect(scopedThreadKey(selectedThread!.environmentId, selectedThread!.id)).toBe(
    scopedThreadKey(environmentId, threadId),
  );
  expect(selectedThread!.title).toBe("Task 7");
  // It is still a thread no list shows: the lists filter on this lineage.
  expect(isListedThreadLineage(selectedThread!.lineage)).toBe(false);
  expect(selectedThread!.archivedAt !== null).toBe(c.archived);
  // Without a row the thread's own detail is what opens it; with one the detail is not read here.
  expect(harness.detailReads.at(-1)).toEqual(
    c.row === null ? [environmentId, threadId] : [null, null],
  );
});

it("has no thread to show when neither the shell nor the thread's detail knows the id", () => {
  harness.route = {
    key: "thread",
    name: "Thread",
    params: threadRouteParams("/threads/environment-1/gone"),
  };
  harness.shell = null;
  harness.detail = { ...EMPTY_ENVIRONMENT_THREAD_STATE, status: "deleted" as const };
  expect(select().selectedThread).toBeNull();
});
