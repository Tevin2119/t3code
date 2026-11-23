import {
  type DeliveryLimitedSeatStatus,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { useLimitedSeatBannerItems } from "./LimitedSeatNotices";

const testState = vi.hoisted(() => ({
  status: null as unknown,
  release: null as (() => void) | null,
  swap: vi.fn(),
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: testState.status, error: null, refresh: () => {} }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => testState.swap }));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
}));

const environmentId = EnvironmentId.make("env-a");
const threadId = ThreadId.make("lead-thread");
const limited = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-fable",
  resetAt: null,
};
const kimi = createModelSelection(ProviderInstanceId.make("kimi"), "kimi-k3");

function setup(status: DeliveryLimitedSeatStatus) {
  testState.status = status;
  testState.release = null;
  testState.swap.mockReset();
  // The server takes a moment, as a fork does; the test decides when it answers.
  testState.swap.mockImplementation(
    () =>
      new Promise((resolve) => {
        testState.release = () =>
          resolve({ _tag: "Success", value: { continuedIn: ThreadId.make("continued") } });
      }),
  );
}

function Notices(props: { readonly onOpenThread: (threadId: ThreadId) => void }) {
  const items = useLimitedSeatBannerItems({
    environmentId,
    threadId,
    providers: [],
    timestampFormat: "locale",
    onOpenThread: props.onOpenThread,
  });
  return <ComposerBannerStack items={items} detached />;
}

it("names the free favorite and swaps to it in one click, however often it is pressed", async () => {
  setup({
    policy: "ask",
    notices: [{ seat: null, limited, state: "offered", substitute: kimi }],
  });
  const onOpenThread = vi.fn();
  await using _screen = await render(<Notices onOpenThread={onOpenThread} />);

  await expect.element(page.getByText("claude-fable has reached its usage limit")).toBeVisible();
  const swap = page.getByRole("button", { name: "Swap to kimi-k3" });
  await swap.click();
  // The button is off while the swap runs, so a second press sends nothing.
  await expect.element(swap).toBeDisabled();
  await swap.click({ force: true });
  expect(testState.swap).toHaveBeenCalledTimes(1);
  expect(testState.swap).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, seat: null, modelSelection: kimi },
  });

  testState.release?.();
  await vi.waitFor(() => expect(onOpenThread).toHaveBeenCalledWith("continued"));
  expect(onOpenThread).toHaveBeenCalledTimes(1);
});

it("says a seat waits when no favorite is free, and offers nothing to press", async () => {
  setup({
    policy: "swap",
    notices: [{ seat: "critic", limited, state: "none-free", substitute: null }],
  });
  await using _screen = await render(<Notices onOpenThread={() => {}} />);

  await expect
    .element(page.getByText("critic: claude-fable has reached its usage limit"))
    .toBeVisible();
  await expect.element(page.getByText("No favorite model is free, so critic waits.")).toBeVisible();
  expect(page.getByRole("button", { name: /Swap/ }).elements()).toHaveLength(0);
});

it("links a lead that was handed on to the thread it continues in", async () => {
  setup({
    policy: "swap",
    notices: [
      {
        seat: null,
        limited,
        state: "swapped",
        substitute: kimi,
        continuedIn: ThreadId.make("continued"),
      },
    ],
  });
  const onOpenThread = vi.fn();
  await using _screen = await render(<Notices onOpenThread={onOpenThread} />);

  await expect.element(page.getByText("Continued on kimi-k3")).toBeVisible();
  await page.getByRole("button", { name: "Open thread" }).click();
  expect(onOpenThread).toHaveBeenCalledWith("continued");
});
