import { expect, it } from "@effect/vitest";

import { resolveDeepSeekModelId } from "./DeepSeekTextGeneration.ts";

it("passes the platform model ids through", () => {
  expect(resolveDeepSeekModelId("deepseek-chat")).toBe("deepseek-chat");
  expect(resolveDeepSeekModelId("deepseek-reasoner")).toBe("deepseek-reasoner");
});

it("maps third-party reasoning aliases onto the reasoner", () => {
  // "deepseek-v4-pro" is a Hermes alias, not an id the DeepSeek API accepts.
  expect(resolveDeepSeekModelId("deepseek-v4-pro")).toBe("deepseek-reasoner");
  expect(resolveDeepSeekModelId("DeepSeek-R1")).toBe("deepseek-reasoner");
  expect(resolveDeepSeekModelId("deepseek-thinking")).toBe("deepseek-reasoner");
});

it("falls back to the chat model for an unset or unknown selection", () => {
  expect(resolveDeepSeekModelId(null)).toBe("deepseek-chat");
  expect(resolveDeepSeekModelId("   ")).toBe("deepseek-chat");
  expect(resolveDeepSeekModelId("deepseek-coder")).toBe("deepseek-chat");
});
