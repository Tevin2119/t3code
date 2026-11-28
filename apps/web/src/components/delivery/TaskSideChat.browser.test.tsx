// "Discuss in a thread" from the task's menu: T3's own side chat of the task thread, opened in
// that thread's right panel and listed among its side chats.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import "~/index.css";
import { getRouter } from "~/router";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import {
  dispatchedCommands,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { parseTask } from "../../lib/delivery";
import { useRightPanelStore } from "../../rightPanelStore";
import { TaskMenu } from "./TaskMenu";
import { useTaskSideChat } from "./useTaskSideChat";

// The socket is the only fake layer.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, unknown> }>(),
      import("../../../test/fakeEnvironment"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);
// The engine is not part of this: the menu's board list and the task's team read nothing.
vi.mock(import("../../state/delivery"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePersonName: () => "Sam",
  useDeliveryAct: () => vi.fn(),
  useDeliveryRead: () =>
    ({ body: [], error: null, isPending: false, readAt: null, refresh: () => {} }) as never,
}));
vi.mock("~/components/delivery/TaskTeamHeader", () => ({ TaskTeamHeader: () => null }));

const lead = { ...threadWithHistory("discuss-lead", 1), engineIntake: "board-task:work:t1" };
const leadRef = scopeThreadRef(ENVIRONMENT_ID, lead.id);
const task = parseTask({
  id: "t1",
  number: 12,
  title: "Fix the sync",
  state: "in-work",
  lane: "implementation",
  card: { id: "t1", number: 12, title: "Fix the sync", lane: "implementation" },
})!;

/** The task's menu, as the task view puts it in the thread's header. */
function Menu() {
  const discuss = useTaskSideChat(leadRef);
  return (
    <TaskMenu
      environmentId={ENVIRONMENT_ID}
      task={task}
      actions={[]}
      taskActions={{ busy: false, run: vi.fn(), moveTo: vi.fn() }}
      onCreateTask={() => {}}
      onAllocate={() => {}}
      onDiscuss={discuss}
      onChanged={() => {}}
      onProblem={() => {}}
    />
  );
}

it("opens a side chat of the task thread, listed among that thread's side chats", async () => {
  await page.viewport(1400, 900);
  using _environment = installFakeEnvironment([lead], { acceptCommands: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  useRightPanelStore.setState(useRightPanelStore.getInitialState());
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${lead.id}`] }),
  );
  await router.load();
  await using _app = await render(
    <>
      <AppRoot router={router} />
      <AppAtomRegistryProvider>
        <div style={{ position: "fixed", bottom: 8, left: 8, zIndex: 100 }}>
          <Menu />
        </div>
      </AppAtomRegistryProvider>
    </>,
    // AppRoot brings its own router.
    { router: false },
  );
  await expect.element(page.getByText(`Answer 0 for ${lead.id}.`)).toBeVisible();

  await page.getByRole("button", { name: "What can be done with this task" }).click();
  await page.getByRole("menuitem", { name: /^Discuss in a thread/ }).click();

  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({ type: "thread.fork", sourceThreadId: lead.id, sideChat: true }),
    ),
  );
  // It opens in the task thread's right panel, as a side chat started there would.
  await expect.element(page.getByRole("button", { name: "Side chat", exact: true })).toBeVisible();
  // With the panel open, the thread's details card is a popover; its side chats list the fork.
  useRightPanelStore.getState().setThreadPanelOpen(leadRef, "popover", true);
  const sideChats = page.getByRole("region", { name: "Side chats" });
  await expect.element(sideChats.getByRole("button", { name: /Side chat/ })).toBeVisible();
  // One action, one side chat, and no turn: nothing is sent to the task thread or the fork.
  expect(
    dispatchedCommands()
      .map((command) => command.type)
      .filter((type) => type !== "thread.visit"),
  ).toEqual(["thread.fork"]);
});
