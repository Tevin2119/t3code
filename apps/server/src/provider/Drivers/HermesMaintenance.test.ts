import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
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

import { parseGenericCliVersion } from "@t3tools/provider-core/server/snapshotProbe";

import {
  hermesMaintenance,
  makeHermesMaintenanceResolution,
  parseHermesInstall,
} from "./HermesMaintenance.ts";

const layerRelease = (respond: () => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, respond()))),
  );

interface Spawned {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv | undefined;
}

/**
 * Answers `git rev-list --count @{upstream}..HEAD` with `git`, and any other command (the
 * launcher's `--version`) with `version`, recording what was asked and with which environment.
 */
const layerSpawner = (
  answers: {
    readonly git: { readonly stdout: string; readonly code: number };
    readonly version?: { readonly stdout: string; readonly code: number };
  },
  calls: Spawned[],
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const spawned = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
        options: { env?: NodeJS.ProcessEnv };
      };
      calls.push({ command: spawned.command, args: spawned.args, env: spawned.options.env });
      const result =
        spawned.command === "git" ? answers.git : (answers.version ?? { stdout: "", code: 1 });
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
const layerGit = (git: { readonly stdout: string; readonly code: number }, calls: Spawned[]) =>
  layerSpawner({ git }, calls);

const versionOutput = (directory: string, method = "git") =>
  [
    "Hermes Agent v0.21.5+6224.gbd0affe (2026.9.24) · upstream bd0affe5",
    `Install directory: ${directory}`,
    `Install method: ${method}`,
    "Python: 3.14.7",
    "Update available — run 'hermes update'",
  ].join("\n");

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
    const calls: Spawned[] = [];
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
      expect(calls.at(-1)).toMatchObject({
        command: "git",
        args: ["-C", checkout, "rev-list", "--count", "@{upstream}..HEAD"],
      });
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

  it.effect(
    "finds the checkout Hermes reports behind a wrapper script, with each instance's own home",
    () => {
      const calls: Spawned[] = [];
      const version = { stdout: "", code: 0 };
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { checkout } = yield* makeCheckout();
        version.stdout = versionOutput(checkout);
        // A custom binary path to a shell script that execs the checkout's own launcher.
        const wrapperHome = yield* fs.makeTempDirectoryScoped();
        const wrapper = path.join(wrapperHome, "bin", "hermes");
        yield* fs.makeDirectory(path.dirname(wrapper), { recursive: true });
        yield* fs.writeFileString(wrapper, `#!/bin/sh\nexec ${checkout}/.hermes/bin/hermes "$@"\n`);
        yield* fs.chmod(wrapper, 0o755);
        const resolveFor = (hermesHome: string) =>
          makeHermesMaintenanceResolution({
            binaryPath: wrapper,
            env: { PATH: "/usr/bin:/bin", HERMES_HOME: hermesHome },
          }).pipe(
            Effect.flatMap((resolve) => resolve()),
            Effect.provide(layerRelease(() => Response.json({ tag_name: "v0.23.5" }))),
          );

        const pm = yield* resolveFor("/profiles/pm/hermes");
        const personal = yield* resolveFor("/profiles/personal/hermes");

        expect(pm.update).toMatchObject({
          executable: wrapper,
          args: ["update", "--yes"],
          env: { HERMES_HOME: "/profiles/pm/hermes" },
        });
        expect(personal.update?.env?.HERMES_HOME).toBe("/profiles/personal/hermes");
        expect(yield* pm.lookupLatestVersion!).toBe("0.23.5");
        // One checkout, one lock: the runner queues the second profile and re-probes it.
        expect(pm.update?.lockKey).toBe(`hermes-git:${normalizeCommandPath(checkout)}`);
        expect(personal.update?.lockKey).toBe(pm.update?.lockKey);
        // Every probe ran with the instance's home, never the default ~/.hermes.
        expect(calls.map((call) => [call.command, call.args[0], call.env?.HERMES_HOME])).toEqual([
          [wrapper, "--version", "/profiles/pm/hermes"],
          ["git", "-C", "/profiles/pm/hermes"],
          [wrapper, "--version", "/profiles/personal/hermes"],
          ["git", "-C", "/profiles/personal/hermes"],
        ]);
      }).pipe(Effect.provide(layerSpawner({ git: { stdout: "0\n", code: 0 }, version }, calls)));
    },
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
  it.effect.each([
    { name: "a pip install", method: "pip", makeCheckoutDirectory: true },
    { name: "an install method it does not know", method: "homebrew", makeCheckoutDirectory: true },
    {
      name: "a git install whose directory is not a checkout",
      method: "git",
      makeCheckoutDirectory: false,
    },
  ])("keeps $name manual even when a checkout sits beside the launcher", (row) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { home, checkout } = yield* makeCheckout();
      const commandPath = path.join(home, "bin", "hermes");
      const reported = row.makeCheckoutDirectory ? checkout : path.join(home, "missing");

      const capabilities = yield* hermesMaintenance
        .resolve({
          binaryPath: "hermes",
          resolvedCommandPath: commandPath,
          realCommandPath: commandPath,
          env: {},
          platform: "linux",
        })
        .pipe(
          Effect.provide(
            layerSpawner(
              {
                git: { stdout: "0\n", code: 0 },
                version: { stdout: versionOutput(reported, row.method), code: 0 },
              },
              [],
            ),
          ),
        );

      expect(capabilities.update).toBeNull();
      expect(capabilities.manualCommand).toBe("hermes update");
    }),
  );
});

describe("Hermes version output", () => {
  it("reads the installed version and install from the real string", () => {
    const output = versionOutput("/Users/me/.hermes/hermes-agent");
    expect(parseGenericCliVersion(output)).toBe("0.21.5");
    expect(parseHermesInstall(output)).toEqual({
      method: "git",
      directory: "/Users/me/.hermes/hermes-agent",
    });
  });

  it.each([
    { output: "", version: null },
    { output: "Hermes Agent (unknown build)", version: null },
    { output: "Hermes Agent v0.21", version: null },
    { output: "Install method:\nInstall directory:", version: null },
  ])("reports nothing it cannot read from $output", ({ output, version }) => {
    expect(parseGenericCliVersion(output)).toBe(version);
    expect(parseHermesInstall(output)).toEqual({ method: null, directory: null });
  });
});
