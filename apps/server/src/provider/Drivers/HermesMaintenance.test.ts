import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import {
  createProviderVersionAdvisory,
  normalizeCommandPath,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { hermesMaintenance, makeHermesMaintenanceResolution } from "./HermesMaintenance.ts";

const layerRelease = (respond: () => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, respond()))),
  );

/** Answers `git rev-list --count @{upstream}..HEAD` and records what was asked. */
const layerGit = (result: { readonly stdout: string; readonly code: number }, calls: string[][]) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const git = command as unknown as { command: string; args: ReadonlyArray<string> };
      calls.push([git.command, ...git.args]);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(result.stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

const makeCheckout = Effect.fn("HermesMaintenance.test.makeCheckout")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped();
  const checkout = path.join(home, "hermes-agent");
  yield* fs.makeDirectory(path.join(checkout, ".git"), { recursive: true });
  yield* fs.writeFileString(path.join(checkout, "pyproject.toml"), "");
  return { home, checkout };
});

it.layer(NodeServices.layer)("HermesMaintenance", (it) => {
  it.effect.each([
    { name: "the checkout's own venv", launcher: ["hermes-agent", "venv", "bin", "hermes"] },
    { name: "a launcher beside the checkout", launcher: ["bin", "hermes"] },
  ])("updates a git checkout launched from $name with hermes update", ({ launcher }) => {
    const calls: string[][] = [];
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const { home, checkout } = yield* makeCheckout();
      const commandPath = path.join(home, ...launcher);
      const env = { HERMES_HOME: home };

      const capabilities = yield* hermesMaintenance.resolve({
        binaryPath: "hermes",
        resolvedCommandPath: commandPath,
        realCommandPath: commandPath,
        env,
        platform: "linux",
      });

      expect(capabilities.update).toMatchObject({
        executable: commandPath,
        args: ["update", "--yes"],
        lockKey: `hermes-git:${normalizeCommandPath(checkout)}`,
        env,
      });
      expect(capabilities.packageName).toBeNull();
      expect(calls).toEqual([["git", "-C", checkout, "rev-list", "--count", "@{upstream}..HEAD"]]);
    }).pipe(Effect.provide(layerGit({ stdout: "0\n", code: 0 }, calls)));
  });

  it.effect.each([
    { name: "has commits its upstream lacks", git: { stdout: "2\n", code: 0 } },
    { name: "has no upstream to compare", git: { stdout: "", code: 128 } },
    { name: "gets an answer that is not a count", git: { stdout: "fatal\n", code: 0 } },
  ])("keeps a checkout manual when it $name", ({ git }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { home } = yield* makeCheckout();
      const commandPath = path.join(home, "bin", "hermes");

      const capabilities = yield* hermesMaintenance.resolve({
        binaryPath: "hermes",
        resolvedCommandPath: commandPath,
        realCommandPath: commandPath,
        env: {},
        platform: "linux",
      });

      expect(capabilities.update).toBeNull();
      expect(capabilities.manualCommand).toBe("hermes update");
    }).pipe(Effect.provide(layerGit(git, []))),
  );

  it.effect("leaves an install without a checkout manual and names the command", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const commandPath = path.join(home, "venvs", "hermes-agent", "bin", "hermes");

      const capabilities = yield* hermesMaintenance.resolve({
        binaryPath: "hermes",
        resolvedCommandPath: commandPath,
        realCommandPath: commandPath,
        env: {},
        platform: "linux",
      });

      expect(
        createProviderVersionAdvisory({
          driver: ProviderDriverKind.make("hermes"),
          currentVersion: "0.21.1",
          latestVersion: "0.23.3",
          maintenanceCapabilities: capabilities,
        }),
      ).toMatchObject({
        status: "behind_latest",
        canUpdate: false,
        updateCommand: "hermes update",
      });
    }),
  );

  it.effect.each([
    {
      name: "a release tag",
      respond: () => Response.json({ tag_name: "v0.23.3" }),
      latest: "0.23.3",
    },
    {
      name: "a tag that is not a version",
      respond: () => Response.json({ tag_name: "nightly" }),
      latest: null,
    },
    {
      name: "a rate-limited response",
      respond: () => new Response("{}", { status: 403 }),
      latest: null,
    },
  ])("reads the latest version from $name on GitHub", ({ respond, latest }) =>
    Effect.gen(function* () {
      const resolve = yield* makeHermesMaintenanceResolution({ binaryPath: null }).pipe(
        Effect.provide(layerRelease(respond)),
      );
      const capabilities = yield* resolve();
      // A null answer must not fall back to npm, whose `hermes-agent` is an unofficial bridge.
      expect(capabilities.latestVersion).toBeNull();
      expect(yield* capabilities.lookupLatestVersion!).toBe(latest);
    }),
  );
});
