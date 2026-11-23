import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { limitedLeadHandoffThreadId } from "@t3tools/shared/limitedSeat";
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

const NOTICE = "This conversation continues in a linked thread";
const sends = () => dispatchedCommands().filter((command) => command.type === "message.dispatch");

/** A thread whose only run stopped short, so its composer would offer "Resume thread". */
function stoppedThread(name: string): FakeThread {
  const history = threadWithHistory(name, 1);
  return { ...history, runs: [{ ...history.runs[0]!, status: "interrupted" }] };
}

async function open(thread: FakeThread) {
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
  return app;
}

it("a thread handed on to a linked thread offers no resume and sends nothing", async () => {
  const old = stoppedThread("handed-on");
  const continued = threadWithHistory(limitedLeadHandoffThreadId(old.runs[0]!.id), 1);
  using _environment = installFakeEnvironment([old, continued], { acceptCommands: true });
  await using _app = await open(old);

  await expect.element(page.getByText(NOTICE)).toBeVisible();
  // With an empty draft the send must not turn into the resume.
  expect(page.getByRole("button", { name: "Resume thread" }).query()).toBeNull();
  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("still there?");
  await vi.waitFor(() => expect(editor.element().textContent).toContain("still there?"));
  await expect.element(page.getByRole("button", { name: NOTICE })).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  expect(editor.element().textContent).toContain("still there?");
  expect(sends()).toEqual([]);

  await userEvent.click(page.getByRole("button", { name: "Open thread" }));
  await expect.element(page.getByText(`${continued.id}: question 0`)).toBeVisible();
});

it("a stopped thread that was not handed on still resumes and sends", async () => {
  const thread = stoppedThread("not-handed-on");
  using _environment = installFakeEnvironment([thread], { acceptCommands: true });
  await using _app = await open(thread);

  expect(page.getByText(NOTICE).query()).toBeNull();
  await expect.element(page.getByRole("button", { name: "Resume thread" })).toBeVisible();
  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("still there?{Enter}");
  await vi.waitFor(() => expect(sends()).toHaveLength(1));
});
