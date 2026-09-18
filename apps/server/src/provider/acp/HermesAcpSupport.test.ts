import { HERMES_DEFAULT_MODEL } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import {
  buildHermesAcpSpawnInput,
  hermesAcpSpawnArgs,
  hermesModelSlug,
  resolveHermesAcpModelId,
} from "./HermesAcpSupport.ts";

it("only passes --accept-hooks when the instance opted into unattended hooks", () => {
  expect(hermesAcpSpawnArgs({ binaryPath: "hermes", acceptHooks: false })).toEqual(["acp"]);
  expect(hermesAcpSpawnArgs({ binaryPath: "hermes", acceptHooks: true })).toEqual([
    "acp",
    "--accept-hooks",
  ]);
});

it("falls back to the CLI on PATH when no binary path is configured", () => {
  expect(buildHermesAcpSpawnInput(null, "/repo")).toEqual({
    command: "hermes",
    args: ["acp"],
    cwd: "/repo",
  });
});

it("writes model ids the way Hermes reports them", () => {
  expect(hermesModelSlug("DeepSeek", "deepseek-v4-pro")).toBe("deepseek:deepseek-v4-pro");
  // A provider Hermes could not name leaves a bare model id rather than ":model".
  expect(hermesModelSlug("", "deepseek-v4-pro")).toBe("deepseek-v4-pro");
  expect(hermesModelSlug("deepseek", "  ")).toBe("");
});

it("keeps Hermes on its own model unless the user picked one", () => {
  expect(resolveHermesAcpModelId(HERMES_DEFAULT_MODEL)).toBeUndefined();
  expect(resolveHermesAcpModelId(null)).toBeUndefined();
  expect(resolveHermesAcpModelId("  ")).toBeUndefined();
  expect(resolveHermesAcpModelId("deepseek:deepseek-v4-pro")).toBe("deepseek:deepseek-v4-pro");
});
