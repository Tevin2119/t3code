import { ThreadInspectionContext } from "./chat/ThreadInspectionContext";
import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { NodeId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  emitThreadEvent,
  isThreadSubscribed,
  runningRun,
  threadWithHistory,
  userItem,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});

it("shows working activity during contributions and critiques before the lead starts", async () => {
  await page.viewport(1400, 900);
  const thread = threadWithHistory("team-working", 1);
  const run = {
    ...runningRun(thread.id, "team-run", 2, "team-question"),
    status: "starting" as const,
    startedAt: null,
  };
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
    container,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
  await vi.waitFor(() => expect(isThreadSubscribed(thread.id)).toBe(true));
  const seat = {
    id: NodeId.make("team-seat"),
    threadId: thread.id,
    runId: run.id,
    parentNodeId: NodeId.make("team-root"),
    origin: "app_owned" as const,
    createdBy: "agent" as const,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "Assess this change",
    title: "Researcher",
    model: "gpt-5.4",
    status: "running" as const,
    result: null,
    startedAt: run.requestedAt,
    completedAt: null,
    updatedAt: run.requestedAt,
    teamChat: { sourceRunId: run.id, stage: "contribution" as const, seat: "researcher" },
  };
  await act(async () => {
    await emitThreadEvent(thread.id, { type: "run.created", payload: run });
    await emitThreadEvent(thread.id, {
      type: "turn-item.updated",
      payload: userItem(thread.id, run.id, "team-question", 2, "Assess this change"),
    });
    await emitThreadEvent(thread.id, { type: "subagent.updated", payload: seat });
  });
  await expect
    .element(screen.getByText("The team is gathering findings.", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText(/^Working/).first()).toBeVisible();
  await act(() =>
    emitThreadEvent(thread.id, {
      type: "subagent.updated",
      payload: { ...seat, teamChat: { ...seat.teamChat, stage: "critique" } },
    }),
  );
  await expect
    .element(screen.getByText("The team is reviewing its findings.", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText(/^Working/).first()).toBeVisible();
  await act(async () => {
    await emitThreadEvent(thread.id, {
      type: "subagent.updated",
      payload: { ...seat, status: "completed", completedAt: run.requestedAt },
    });
    await emitThreadEvent(thread.id, {
      type: "run.updated",
      payload: { ...run, status: "running", startedAt: run.requestedAt },
    });
  });
  const leadNotice = screen.getByText("Steer reaches the lead only. The seats have finished.", {
    exact: true,
  });
  await expect.element(leadNotice).toBeVisible();
  await act(() =>
    emitThreadEvent(thread.id, {
      type: "run.updated",
      payload: { ...run, status: "completed", completedAt: run.requestedAt },
    }),
  );
  await expect.element(leadNotice).not.toBeInTheDocument();
});

it("opens a timeline parent through the containing workspace", async () => {
  await page.viewport(1400, 900);
  const parent = threadWithHistory("inspected-parent", 1);
  const child = { ...threadWithHistory("inspected-child", 1), sideChatOf: parent.id };
  using _environment = installFakeEnvironment([parent, child]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const path = `/${ENVIRONMENT_ID}/${child.id}`;
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const inspect = vi.fn();
  await using screen = await render(
    <ThreadInspectionContext value={inspect}>
      <AppRoot router={router} />
    </ThreadInspectionContext>,
    { router: false },
  );
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  await screen.getByRole("button", { name: "Open parent thread", exact: true }).click();
  expect(inspect).toHaveBeenCalledWith({ environmentId: ENVIRONMENT_ID, threadId: parent.id });
  expect(router.state.location.pathname).toBe(path);
});
