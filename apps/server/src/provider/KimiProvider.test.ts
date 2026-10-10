import { expect, it } from "@effect/vitest";

import { parseKimiProviderCatalog } from "./KimiProvider.ts";

// Captured verbatim from `kimi provider list --json` on Kimi Code CLI 0.42.0.
const SIGNED_IN_OUTPUT = JSON.stringify({
  providers: {
    "managed:kimi-code": {
      baseUrl: "https://api.kimi.com/coding/v1",
      type: "kimi",
      apiKey: "",
      oauth: { storage: "file", key: "oauth/kimi-code" },
    },
  },
  models: {
    "kimi-code/kimi-for-coding": {
      provider: "managed:kimi-code",
      model: "kimi-for-coding",
      displayName: "K2.7 Coding",
    },
    "kimi-code/k3": { provider: "managed:kimi-code", model: "k3", displayName: "K3" },
  },
});

it("reads the model catalog and an OAuth login from the CLI", () => {
  const catalog = parseKimiProviderCatalog(SIGNED_IN_OUTPUT);

  expect(catalog?.auth).toEqual({
    status: "authenticated",
    type: "oauth",
    label: "Kimi account",
  });
  expect(catalog?.models.map((model) => [model.slug, model.name])).toEqual([
    ["kimi-code/kimi-for-coding", "K2.7 Coding"],
    ["kimi-code/k3", "K3"],
  ]);
});

it("marks the account default model as default", () => {
  const catalog = parseKimiProviderCatalog(SIGNED_IN_OUTPUT);

  const models = new Map(catalog?.models.map((model) => [model.slug, model]));
  expect(models.get("kimi-code/kimi-for-coding")?.isDefault).toBe(true);
  expect(models.get("kimi-code/k3")?.isDefault).toBeUndefined();
});

it("treats a provider with no credentials as signed out", () => {
  const catalog = parseKimiProviderCatalog(
    JSON.stringify({
      providers: { "managed:kimi-code": { type: "kimi", apiKey: "" } },
      models: {},
    }),
  );

  expect(catalog?.auth).toEqual({ status: "unauthenticated" });
});

it("reports an API-key login when no OAuth block is stored", () => {
  const catalog = parseKimiProviderCatalog(
    JSON.stringify({
      providers: { custom: { type: "kimi", apiKey: "sk-live" } },
      models: {},
    }),
  );

  expect(catalog?.auth).toEqual({
    status: "authenticated",
    type: "api-key",
    label: "API key",
  });
});

it("falls back to undefined rather than guessing when the CLI prints no JSON", () => {
  expect(parseKimiProviderCatalog("kimi: command failed")).toBeUndefined();
  expect(parseKimiProviderCatalog("{not json")).toBeUndefined();
});

it("skips a banner line printed before the JSON document", () => {
  const catalog = parseKimiProviderCatalog(`kimi version 0.42.0\n${SIGNED_IN_OUTPUT}`);

  expect(catalog?.auth.status).toBe("authenticated");
});
