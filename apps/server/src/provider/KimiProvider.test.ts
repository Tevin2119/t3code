// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { KimiSettings } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { parseKimiProviderCatalog, probeKimiAuthenticated } from "./KimiProvider.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);

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

it.effect("reads the catalog Kimi 2.7 prints without waiting for the process to exit", () =>
  Effect.gen(function* () {
    // Kimi 2.7 prints the catalog at once and then idles before it exits, past the probe timeout.
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kimi-linger-"));
    const binaryPath = NodePath.join(dir, "kimi");
    NodeFS.writeFileSync(
      binaryPath,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(SIGNED_IN_OUTPUT)});\nsetTimeout(() => {}, 600_000);\n`,
      { mode: 0o755 },
    );
    const settings = decodeKimiSettings({ binaryPath });

    expect(yield* probeKimiAuthenticated(settings)).toBe(true);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);
