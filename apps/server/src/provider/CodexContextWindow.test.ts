import { assert, it } from "@effect/vitest";
import { createModelCapabilities } from "@t3tools/shared/model";
import { applyCodexContextWindows, codexContextWindowConfig } from "./CodexContextWindow.ts";

const models = [
  {
    slug: "gpt-test",
    name: "Test",
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  },
];
const cache = (context_window: number, max_context_window: number) =>
  JSON.stringify({ models: [{ slug: "gpt-test", context_window, max_context_window }] });

it("offers the model's reported standard and expanded windows, without assuming 1M", () => {
  const descriptor = applyCodexContextWindows(models, cache(272000, 872000))[0]?.capabilities
    ?.optionDescriptors?.[0];
  assert.deepStrictEqual(descriptor, {
    id: "contextWindow",
    label: "Context Window",
    type: "select",
    options: [
      { id: "272000", label: "272k", isDefault: true },
      { id: "872000", label: "872k" },
    ],
    currentValue: "272000",
  });
});

it("does not invent context choices for missing, malformed, fixed-size or unrelated catalogs", () => {
  for (const text of [
    "bad json",
    "{}",
    cache(272000, 272000),
    cache(272000, -1),
    cache(1.5, 1000000),
    JSON.stringify({
      models: [{ slug: "another-model", context_window: 272000, max_context_window: 1000000 }],
    }),
  ]) {
    assert.deepStrictEqual(applyCodexContextWindows(models, text), models);
  }
});

it("keeps valid model entries when a neighboring catalog entry is invalid", () => {
  const parsed = JSON.parse(cache(272000, 1000000));
  parsed.models.push({ slug: "malformed" });
  const descriptor = applyCodexContextWindows(models, JSON.stringify(parsed))[0]?.capabilities
    ?.optionDescriptors?.[0];
  assert.equal(descriptor?.type, "select");
  if (descriptor?.type === "select") assert.equal(descriptor.options[1]?.label, "1M");
});

it("sets a numeric native override and supports returning to the standard window", () => {
  for (const tokens of [872000, 272000]) {
    assert.deepStrictEqual(
      codexContextWindowConfig({
        model: "gpt-test",
        options: [{ id: "contextWindow", value: String(tokens) }],
      }),
      { model_context_window: tokens },
    );
  }
  assert.deepStrictEqual(codexContextWindowConfig({ model: "gpt-test" }), {});
  assert.deepStrictEqual(codexContextWindowConfig(undefined), {});
});

it("rejects malformed selections instead of silently running with a different window", () => {
  for (const value of [true, "1m", "-1", "0", "1.5", "9007199254740992"]) {
    assert.throws(
      () =>
        codexContextWindowConfig({ model: "gpt-test", options: [{ id: "contextWindow", value }] }),
      /Invalid Codex context/,
    );
  }
});
