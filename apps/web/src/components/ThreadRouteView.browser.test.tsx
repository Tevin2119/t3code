import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the test.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
  type FakeThread,
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

it.each([
  { name: "the shell carries it", offShell: false },
  { name: "the shell leaves it out", offShell: true },
])("opens a thread no list shows by id, from a link and after a reload, when $name", async (c) => {
  const listed = threadWithHistory("probe-listed", 1);
  const unlisted: FakeThread = {
    ...threadWithHistory("probe-unlisted", 1),
    engineIntake: "board-task:probe",
    ...(c.offShell ? { offShell: true as const } : {}),
  };
  using _environment = installFakeEnvironment([listed, unlisted]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const open = async (path: string) => {
    const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
    await router.load();
    return router;
  };
  const params = { environmentId: ENVIRONMENT_ID, threadId: unlisted.id };
  const sidebarRows = () =>
    Array.from(document.querySelectorAll("[data-thread-item]"), (row) =>
      row.getAttribute("data-thread-item"),
    );

  {
    const router = await open(`/${ENVIRONMENT_ID}/${listed.id}`);
    // AppRoot brings its own router.
    await using _app = await render(<AppRoot router={router} />, { router: false });
    await expect.element(page.getByText("probe-listed: question 0")).toBeVisible();
    await expect.poll(sidebarRows).toEqual([expect.stringContaining(listed.id)]);
    await act(() => router.navigate({ to: "/$environmentId/$threadId", params }));
    await expect.element(page.getByText("probe-unlisted: question 0")).toBeVisible();
  }
  // A reload or a pasted link starts a new router on the thread's own address.
  const router = await open(`/${ENVIRONMENT_ID}/${unlisted.id}`);
  // AppRoot brings its own router.
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText("probe-unlisted: question 0")).toBeVisible();
  expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${unlisted.id}`);
  await expect.poll(sidebarRows).toEqual([expect.stringContaining(listed.id)]);
});
