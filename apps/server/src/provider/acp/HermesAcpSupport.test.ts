import { HERMES_DEFAULT_MODEL } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  buildHermesAcpSpawnInput,
  dropNonProtocolLines,
  hermesAcpSpawnArgs,
  hermesModelSlug,
  makeHermesEnvironment,
  resolveHermesAcpModelId,
} from "./HermesAcpSupport.ts";

it("only passes --accept-hooks when the instance opted into unattended hooks", () => {
  expect(hermesAcpSpawnArgs({ acceptHooks: false })).toEqual(["acp"]);
  expect(hermesAcpSpawnArgs({ acceptHooks: true })).toEqual(["acp", "--accept-hooks"]);
});

it("falls back to the CLI on PATH when no binary path is configured", () => {
  expect(buildHermesAcpSpawnInput(null, "/repo")).toEqual({
    command: "hermes",
    args: ["acp"],
    cwd: "/repo",
  });
});

it("runs hermes acp against the instance's scoped HERMES_HOME", () => {
  const scopedHome = "/scoped/hermes";
  const spawn = buildHermesAcpSpawnInput(
    { binaryPath: "hermes", homePath: scopedHome, acceptHooks: false },
    "/repo",
    { PATH: "/bin", HERMES_HOME: "/ambient" },
  );
  expect(spawn.env).toEqual({ PATH: "/bin", HERMES_HOME: scopedHome });
});

it("leaves an inherited HERMES_HOME alone when no home path is configured", () => {
  const environment = { PATH: "/bin", HERMES_HOME: "/ambient" };
  expect(makeHermesEnvironment({ homePath: "" }, environment)).toBe(environment);
  expect(
    buildHermesAcpSpawnInput(
      { binaryPath: "hermes", homePath: "", acceptHooks: false },
      "/repo",
      environment,
    ).env,
  ).toBe(environment);
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

it.effect("drops lines a command printed onto the ACP stream and keeps every message whole", () =>
  Effect.gen(function* () {
    const encoder = new TextEncoder();
    // Chunks do not end where lines do, and the last message has no trailing newline.
    const chunks = [
      '{"jsonrpc":"2.0","id":1,"re',
      'sult":{}}\n--- scanning fares\n',
      'Traceback (most recent call last):\n  {"jsonrpc":"2.0","method":"a"}\n\n',
      '{"jsonrpc":"2.0","method":"b"}',
    ].map((chunk) => encoder.encode(chunk));
    const kept = yield* dropNonProtocolLines(Stream.fromIterable(chunks)).pipe(Stream.runCollect);
    expect([...kept].map((line) => new TextDecoder().decode(line))).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{}}\n',
      '  {"jsonrpc":"2.0","method":"a"}\n',
      '{"jsonrpc":"2.0","method":"b"}',
    ]);
  }),
);
