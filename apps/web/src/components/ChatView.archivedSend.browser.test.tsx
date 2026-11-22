import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the test.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
  type FakeThread,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

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

const REFUSAL = "This thread is archived and cannot receive messages.";
const sends = () => dispatchedCommands().filter((command) => command.type === "message.dispatch");

async function openAndType(thread: FakeThread) {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  // AppRoot brings its own router.
  const app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText(`${thread.id}: question 0`)).toBeVisible();
  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("still there?");
  await vi.waitFor(() => expect(editor.element().textContent).toContain("still there?"));
  return app;
}

// An archived board task's thread is the archived thread a person can reach: it opens by id.
it("an archived board thread says it takes no message, and sends none", async () => {
  const thread: FakeThread = {
    ...threadWithHistory("archived-board", 1),
    engineIntake: "board-task:probe",
    archived: true,
  };
  using _environment = installFakeEnvironment([thread], { acceptCommands: true });
  await using _app = await openAndType(thread);

  await expect.element(page.getByText(REFUSAL)).toBeVisible();
  await expect.element(page.getByRole("button", { name: REFUSAL })).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  // The refusal is still on screen and the words are still in the composer.
  await expect.element(page.getByText(REFUSAL)).toBeVisible();
  expect(page.getByTestId("composer-editor").element().textContent).toContain("still there?");
  expect(sends()).toEqual([]);
});

it("a live board thread still sends", async () => {
  const thread: FakeThread = {
    ...threadWithHistory("live-board", 1),
    engineIntake: "board-task:probe",
    offShell: true,
  };
  using _environment = installFakeEnvironment([thread], { acceptCommands: true });
  await using _app = await openAndType(thread);

  expect(page.getByText(REFUSAL).query()).toBeNull();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(sends()).toHaveLength(1));
});
