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
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";
import {
  ENVIRONMENT_ID,
  emitShellThread,
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

// A server that serves families sends no board task's row in its snapshot. A change to the thread
// still brings its row in as a delta. An archived one is in no shell and no family.
const SHELL_ROWS = [
  { shell: "got its row as a delta", fixture: { offShell: true }, delta: true },
  { shell: "leaves its row out", fixture: { offShell: true }, delta: false },
  { shell: "has archived it", fixture: { archived: true }, delta: false },
] as const;
const HIDDEN_TAGS = ["private"];
// The server's settings arrive after the first paint, so the filter takes a moment to apply.
const SETTLED = { timeout: 10_000 };

it.each(
  SHELL_ROWS.flatMap((row) => [
    { ...row, filter: "off", tagFilter: false, tag: "no tag", tags: [] },
    { ...row, filter: "on", tagFilter: true, tag: "no tag", tags: [] },
    // The filter hides rows of lists. A board task's thread is in none, so its tag closes nothing.
    { ...row, filter: "on", tagFilter: true, tag: "a hidden tag", tags: HIDDEN_TAGS },
    // Each case has its own thread: a detail cached by an earlier case would open a thread the
    // route is about to close.
  ]).map((row, index) => ({ ...row, name: `probe-unlisted-${index}` })),
)(
  "opens a board task's thread by id, from a link and after a reload, when the shell $shell, the tag filter is $filter and it carries $tag",
  async (c) => {
    const listed = threadWithHistory("probe-listed", 1);
    // A listed thread the filter hides: its row leaving the sidebar says the filter is in force.
    const tagged: FakeThread = { ...threadWithHistory("probe-tagged", 1), tags: HIDDEN_TAGS };
    const unlisted: FakeThread = {
      ...threadWithHistory(c.name, 1),
      engineIntake: "board-task:probe",
      tags: c.tags,
      ...c.fixture,
    };
    using _environment = installFakeEnvironment(
      [listed, tagged, unlisted],
      c.tagFilter ? { hiddenThreadTags: HIDDEN_TAGS } : undefined,
    );
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
    const path = `/${ENVIRONMENT_ID}/${unlisted.id}`;
    // Which fixtures have a sidebar row. The board task's thread never does.
    const sidebarRows = () => {
      const rows = Array.from(document.querySelectorAll("[data-thread-item]"), (row) =>
        row.getAttribute("data-thread-item"),
      );
      return [listed, tagged, unlisted]
        .filter((thread) => rows.some((row) => row?.includes(thread.id)))
        .map((thread) => thread.id);
    };
    const shellRow = () =>
      appAtomRegistry.get(environmentThreadShells.quietThreadShellAtom(params)) !== null;
    const listedRows = c.tagFilter ? [listed.id] : [listed.id, tagged.id];

    {
      const router = await open(`/${ENVIRONMENT_ID}/${listed.id}`);
      // AppRoot brings its own router.
      await using _app = await render(<AppRoot router={router} />, { router: false });
      await expect.element(page.getByText("probe-listed: question 0")).toBeVisible();
      await expect.poll(sidebarRows, SETTLED).toEqual(listedRows);
      if (c.delta) {
        await emitShellThread(unlisted.id);
        await expect.poll(shellRow).toBe(true);
      }
      await act(() => router.navigate({ to: "/$environmentId/$threadId", params }));
      await expect.element(page.getByText(`${c.name}: question 0`)).toBeVisible();
      expect(router.state.location.pathname).toBe(path);
    }
    // A reload or a pasted link starts a new router on the thread's own address.
    const router = await open(path);
    // AppRoot brings its own router.
    await using _app = await render(<AppRoot router={router} />, { router: false });
    // The sidebar first, so the open is judged with the shell and the filter loaded.
    await expect.poll(sidebarRows, SETTLED).toEqual(listedRows);
    await expect.element(page.getByText(`${c.name}: question 0`)).toBeVisible();
    expect(router.state.location.pathname).toBe(path);
    // The open thread reads its row from the shell, or from its family when the shell left it out.
    await expect.poll(shellRow, SETTLED).toBe(!("archived" in c.fixture));
    expect(sidebarRows()).toEqual(listedRows);
  },
);
