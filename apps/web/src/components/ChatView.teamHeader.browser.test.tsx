// After a switch between two empty board-task threads in one ChatView, the team header names the
// thread now open, not the one just left.
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
import stylesheet from "~/index.css?inline";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, unknown> }>(),
    import("../../test/fakeEnvironment"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock("~/components/delivery/TaskTeamHeader", () => ({
  TaskTeamHeader: (props: { readonly threadId: string }) => (
    <section data-testid="task-team-header" data-header-thread={String(props.threadId)} />
  ),
}));
// Names the thread ChatView holds open, beside the header it drew.
vi.mock("~/components/chat/ChatBannerLane", () => ({
  ChatBannerLane: (props: { readonly threadId: string }) => (
    <span data-testid="active-thread" data-active-thread={String(props.threadId)} />
  ),
}));

it("an empty board task thread opened from another shows its own team, not the one just left", async () => {
  await page.viewport(1400, 900);
  const style = document.createElement("style");
  style.textContent = stylesheet;
  document.head.append(style);
  const first = { ...threadWithHistory("team-header-first", 0), engineIntake: "board-task:a" };
  const second = { ...threadWithHistory("team-header-second", 0), engineIntake: "board-task:b" };
  const environment = installFakeEnvironment([first, second]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${second.id}`] }),
  );
  await router.load();
  const app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  try {
    await expect
      .element(page.getByTestId("task-team-header"))
      .toHaveAttribute("data-header-thread", second.id);
    await router.navigate({ to: `/${ENVIRONMENT_ID}/${first.id}` });
    await expect
      .element(page.getByTestId("active-thread"))
      .toHaveAttribute("data-active-thread", first.id);
    // Nothing else renders the timeline again, so a stale header would stay.
    await expect
      .element(page.getByTestId("task-team-header"))
      .toHaveAttribute("data-header-thread", first.id);
  } finally {
    await app[Symbol.asyncDispose]();
    environment[Symbol.dispose]();
    style.remove();
  }
});
