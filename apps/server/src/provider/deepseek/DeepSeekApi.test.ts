import { expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";

import { resolveDeepSeekCredentials } from "./DeepSeekApi.ts";

const settings = (patch: { apiKey?: string; baseUrl?: string } = {}) => ({
  apiKey: patch.apiKey ?? "",
  baseUrl: patch.baseUrl ?? "",
});

it("prefers the configured key over the environment", () => {
  const credentials = resolveDeepSeekCredentials(settings({ apiKey: "  from-settings  " }), {
    DEEPSEEK_API_KEY: "from-env",
  });

  expect(credentials && Redacted.value(credentials.apiKey)).toBe("from-settings");
});

it("falls back to DEEPSEEK_API_KEY so the key need not live in settings.json", () => {
  const credentials = resolveDeepSeekCredentials(settings(), { DEEPSEEK_API_KEY: "from-env" });

  expect(credentials && Redacted.value(credentials.apiKey)).toBe("from-env");
});

it("reports no credentials rather than an empty key", () => {
  expect(resolveDeepSeekCredentials(settings(), {})).toBeUndefined();
  expect(resolveDeepSeekCredentials(settings({ apiKey: "   " }), { DEEPSEEK_API_KEY: " " })).toBe(
    undefined,
  );
});

it("keeps the key out of string interpolation", () => {
  const credentials = resolveDeepSeekCredentials(settings({ apiKey: "secret-value" }), {});

  expect(`${credentials?.apiKey}`).not.toContain("secret-value");
});

it("trims a trailing slash off a custom base URL so paths do not double up", () => {
  const credentials = resolveDeepSeekCredentials(
    settings({ apiKey: "k", baseUrl: "https://proxy.example/v1/" }),
    {},
  );

  expect(credentials?.baseUrl).toBe("https://proxy.example/v1");
});

it("defaults to the DeepSeek endpoint", () => {
  expect(resolveDeepSeekCredentials(settings({ apiKey: "k" }), {})?.baseUrl).toBe(
    "https://api.deepseek.com",
  );
});
