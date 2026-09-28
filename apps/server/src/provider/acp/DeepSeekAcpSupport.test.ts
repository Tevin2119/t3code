// @effect-diagnostics nodeBuiltinImport:off - joins paths inside a scoped temp directory.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  credentialFileHoldsApiKey,
  dotenvHoldsApiKey,
  probeDeepSeekAuthenticated,
} from "../Layers/DeepSeekProvider.ts";
import {
  buildDeepSeekAcpSpawnInput,
  currentDeepSeekModelIdFromSessionSetup,
  deepseekModelSlugFromConfigValue,
  resolveDeepSeekAcpModelId,
} from "./DeepSeekAcpSupport.ts";

describe("buildDeepSeekAcpSpawnInput", () => {
  it("boots the ACP profile and scopes a configured home", () => {
    expect(buildDeepSeekAcpSpawnInput({ binaryPath: "", homePath: "" }, "/work")).toEqual({
      command: "dsh",
      args: ["--profile", "acp"],
      cwd: "/work",
    });
    const scoped = buildDeepSeekAcpSpawnInput(
      { binaryPath: "/opt/dsh", homePath: "/srv/dsh-home" },
      "/work",
      { PATH: "/bin" },
    );
    expect(scoped.command).toBe("/opt/dsh");
    expect(scoped.env).toEqual({ PATH: "/bin", DSH_HOME: "/srv/dsh-home" });
  });
});

describe("DeepSeek model ids", () => {
  it("sends a bare slug as a model of the official backend", () => {
    expect(resolveDeepSeekAcpModelId("deepseek-v4-pro")).toBe(
      '["deepseek-official","deepseek-v4-pro"]',
    );
    expect(resolveDeepSeekAcpModelId(" other-backend/some-model ")).toBe(
      '["other-backend","some-model"]',
    );
    for (const empty of [undefined, null, "", "  ", "backend/"]) {
      expect(resolveDeepSeekAcpModelId(empty)).toBeUndefined();
    }
  });

  it("reads the slug back from the config value the harness reports", () => {
    expect(deepseekModelSlugFromConfigValue('["deepseek-official","deepseek-v4-flash"]')).toBe(
      "deepseek-v4-flash",
    );
    expect(deepseekModelSlugFromConfigValue('["other-backend", "some-model"]')).toBe(
      "other-backend/some-model",
    );
    expect(deepseekModelSlugFromConfigValue("deepseek-v4-pro")).toBeUndefined();
  });

  it("takes the current model from the model config option", () => {
    expect(
      currentDeepSeekModelIdFromSessionSetup({
        sessionId: "s",
        configOptions: [
          {
            id: "reasoning_effort",
            name: "Reasoning effort",
            type: "select",
            currentValue: "high",
            options: [],
          },
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: '["deepseek-official","deepseek-v4-flash"]',
            options: [],
          },
        ],
      }),
    ).toBe('["deepseek-official","deepseek-v4-flash"]');
    expect(currentDeepSeekModelIdFromSessionSetup({ sessionId: "s" })).toBeUndefined();
  });
});

describe("DeepSeek credential files", () => {
  it("finds a key under refs and ignores an empty or unrelated one", () => {
    const stored = [
      "version: 1",
      "records:",
      "  client-connection/browser-session:",
      "    kind: secret",
      "refs:",
      "  DEEPSEEK_API_KEY: sk-abc",
    ].join("\n");
    expect(credentialFileHoldsApiKey(stored)).toBe(true);
    expect(credentialFileHoldsApiKey(stored.replace("sk-abc", '""'))).toBe(false);
    expect(credentialFileHoldsApiKey("refs:\n  OTHER_KEY: x\n")).toBe(false);
    expect(credentialFileHoldsApiKey("records:\n  DEEPSEEK_API_KEY: x\n")).toBe(false);
    expect(credentialFileHoldsApiKey("")).toBe(false);
  });

  it("finds a key in a dotenv file", () => {
    expect(dotenvHoldsApiKey("export DEEPSEEK_API_KEY='sk-abc'\n")).toBe(true);
    expect(dotenvHoldsApiKey("# DEEPSEEK_API_KEY=sk-abc\nDEEPSEEK_API_KEY=\n")).toBe(false);
  });
});

it.layer(NodeServices.layer)("probeDeepSeekAuthenticated", (it) => {
  it.effect("reads the key the way the harness resolves it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      expect(yield* probeDeepSeekAuthenticated({ DSH_HOME: home })).toBe(false);
      expect(yield* probeDeepSeekAuthenticated({ DSH_HOME: home, DEEPSEEK_API_KEY: "sk" })).toBe(
        true,
      );
      yield* fs.writeFileString(NodePath.join(home, ".env"), "DEEPSEEK_API_KEY=sk-env\n");
      expect(yield* probeDeepSeekAuthenticated({ DSH_HOME: home })).toBe(true);
      yield* fs.remove(NodePath.join(home, ".env"));
      yield* fs.writeFileString(
        NodePath.join(home, ".credentials.yaml"),
        "version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-file\n",
      );
      expect(yield* probeDeepSeekAuthenticated({ DSH_HOME: home })).toBe(true);
    }).pipe(Effect.scoped),
  );
});
