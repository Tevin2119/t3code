import { type DeliveryLimitedSeatNotice, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { expect, it } from "vite-plus/test";

import { limitedSeatNoticeViews } from "./limitedSeatNotices.ts";

const limited = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-fable",
  resetAt: "2026-11-22T17:00:00.000Z",
};
const kimi = createModelSelection(ProviderInstanceId.make("kimi"), "kimi-k3");
const options = {
  modelName: (model: { readonly model: string }) => model.model.toUpperCase(),
  formatReset: () => "Resets 5 PM",
};
const views = (notices: ReadonlyArray<DeliveryLimitedSeatNotice>, policy: "ask" | null = "ask") =>
  limitedSeatNoticeViews({ policy, notices }, options);

it("shows nothing where the setting does not govern or nothing was read yet", () => {
  const notice = { seat: null, limited, state: "offered", substitute: kimi } as const;
  expect(views([notice], null)).toEqual([]);
  expect(limitedSeatNoticeViews(null, options)).toEqual([]);
});

it("offers a seat the free favorite by name, from the next message", () => {
  const [view] = views([{ seat: "critic", limited, state: "offered", substitute: kimi }]);
  expect(view).toMatchObject({
    title: "critic: CLAUDE-FABLE has reached its usage limit",
    description: "KIMI-K3 is free. critic uses it from your next message.",
    action: { type: "swap", label: "Swap to KIMI-K3", substitute: kimi },
  });
});

it("says when the limit resets where no favorite is free", () => {
  const [view] = views([{ seat: null, limited, state: "none-free", substitute: null }]);
  expect(view).toMatchObject({
    description: "No favorite model is free, so this conversation waits. Resets 5 PM",
    action: null,
  });
});

it("says what stands in for a seat a person agreed to swap", () => {
  const [view] = views([{ seat: "critic", limited, state: "swapped", substitute: kimi }]);
  expect(view).toMatchObject({ title: "critic runs on KIMI-K3", action: null });
});
