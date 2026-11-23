import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the test.
import "~/components/ChatView";
import { useComposerDraftStore } from "~/composerDraftStore";
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

// The reverse of the board-thread probe in ThreadRouteView.browser.test.tsx: what that work must
// not have loosened for ordinary threads. Its own file, since the shell rows of a file's first
// test stay for the rest of it.
const HIDDEN_TAGS = ["private"];
// The server's settings arrive after the first paint, so the filter takes a moment to apply.
const SETTLED = { timeout: 10_000 };

it("still opens an ordinary thread with the tag filter on, and still keeps a hidden or an archived one closed", async () => {
  using stack = new DisposableStack();
  const initialDrafts = useComposerDraftStore.getState();
  stack.defer(() => useComposerDraftStore.setState(initialDrafts, true));
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  const listed = threadWithHistory("ordinary-listed", 1);
  const other = threadWithHistory("ordinary-other", 1);
  const tagged: FakeThread = { ...threadWithHistory("ordinary-tagged", 1), tags: HIDDEN_TAGS };
  const archived: FakeThread = { ...threadWithHistory("ordinary-archived", 1), archived: true };
  using _environment = installFakeEnvironment([listed, other, tagged, archived], {
    hiddenThreadTags: HIDDEN_TAGS,
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${listed.id}`] }),
  );
  await router.load();
  // AppRoot brings its own router.
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const sidebarRows = () =>
    Array.from(document.querySelectorAll("[data-thread-item]"), (row) =>
      row.getAttribute("data-thread-item"),
    );
  const open = (thread: FakeThread) =>
    act(() =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId: thread.id },
      }),
    );
  const pathname = () => router.state.location.pathname;

  await expect.element(page.getByText("ordinary-listed: question 0")).toBeVisible();
  // The tagged thread's row leaving the sidebar says the filter is in force.
  await expect
    .poll(sidebarRows, SETTLED)
    .toEqual([expect.stringContaining(listed.id), expect.stringContaining(other.id)]);

  await open(other);
  await expect.element(page.getByText("ordinary-other: question 0")).toBeVisible();
  expect(pathname()).toBe(`/${ENVIRONMENT_ID}/${other.id}`);

  // The index opens a draft after a rejected thread address redirects home.
  await open(tagged);
  await expect.poll(pathname, SETTLED).toMatch(/^\/draft\/[^/]+$/);
  expect(document.body.textContent).not.toContain("ordinary-tagged: question 0");

  // Archived, and not server-owned: it is restored from the archive, not opened by id.
  await open(archived);
  await expect.poll(pathname, SETTLED).toMatch(/^\/draft\/[^/]+$/);
  expect(document.body.textContent).not.toContain("ordinary-archived: question 0");
});
