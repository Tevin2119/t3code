import { ProviderDriverKind } from "@t3tools/contracts";
import {
  isNixStoreCommandPath,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilitiesResolver,
  type ProviderMaintenanceResolutionContext,
  type ProviderMaintenanceResolverServices,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const DRIVER = ProviderDriverKind.make("hermes");
// PyPI's `hermes-agent` lags the releases and npm's is an unofficial bridge.
const LATEST_RELEASE = "https://api.github.com/repos/NousResearch/hermes-agent/releases/latest";
const decodeRelease = Schema.decodeUnknownEffect(Schema.Struct({ tag_name: Schema.String }));

/** Runs a short, non-interactive command and returns its stdout when it exits 0, else null. */
const readCommandOutput = Effect.fn("HermesMaintenance.readCommandOutput")(function* (
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        env: { ...env, GIT_TERMINAL_PROMPT: "0" },
        extendEnv: true,
        stdin: "ignore",
        stderr: "ignore",
      }),
    );
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    const [stdout, exitCode] = yield* Effect.all(
      [collectUint8StreamText({ stream: child.stdout, maxBytes: 4096 }), child.exitCode],
      { concurrency: "unbounded" },
    );
    return Number(exitCode) === 0 ? stdout.text : null;
  });
  return yield* run.pipe(
    Effect.scoped,
    Effect.timeoutOption("20 seconds"),
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );
});

/** The install method and directory `hermes --version` reports, each null when it is silent. */
export function parseHermesInstall(output: string): {
  readonly method: string | null;
  readonly directory: string | null;
} {
  const field = (name: string) =>
    new RegExp(`^[ \\t]*${name}:[ \\t]*(\\S.*?)[ \\t]*$`, "im").exec(output)?.[1] ?? null;
  return {
    method: field("Install method")?.toLowerCase() ?? null,
    directory: field("Install directory"),
  };
}

const isHermesCheckout = Effect.fn("HermesMaintenance.isCheckout")(function* (candidate: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.all([
    fs.exists(path.join(candidate, ".git")),
    fs.exists(path.join(candidate, "pyproject.toml")),
  ]).pipe(
    Effect.map((found) => found.every(Boolean)),
    Effect.orElseSucceed(() => false),
  );
});

/**
 * The checkout a Hermes launcher runs, or null. Hermes names its own install, which finds
 * checkouts behind wrapper scripts; older builds that do not are located from the launcher:
 * the official installer runs the checkout from `<checkout>/venv`, with a launcher in a `bin`
 * beside the checkout on Windows.
 */
const findHermesCheckout = Effect.fn("HermesMaintenance.findCheckout")(function* (
  context: ProviderMaintenanceResolutionContext,
) {
  const path = yield* Path.Path;
  const output = yield* readCommandOutput(context.resolvedCommandPath, ["--version"], context.env);
  const reported = parseHermesInstall(output ?? "");
  if (reported.method !== null) {
    return reported.method === "git" &&
      reported.directory !== null &&
      (yield* isHermesCheckout(reported.directory))
      ? reported.directory
      : null;
  }
  for (const commandPath of [context.realCommandPath, context.resolvedCommandPath]) {
    const binDirectory = path.dirname(commandPath);
    const parent = path.dirname(binDirectory);
    const candidates = [
      ...(path.basename(parent).toLowerCase() === "venv" ? [path.dirname(parent)] : []),
      path.join(parent, "hermes-agent"),
    ];
    for (const candidate of candidates) {
      if (yield* isHermesCheckout(candidate)) return candidate;
    }
  }
  return null;
});

/**
 * Commits on the checkout's branch that its upstream lacks, or null when git cannot say.
 * `hermes update` resets a diverged tracked branch to its remote, which discards them.
 */
const countUnpushedCommits = (checkout: string, env: NodeJS.ProcessEnv) =>
  readCommandOutput("git", ["-C", checkout, "rev-list", "--count", "@{upstream}..HEAD"], env).pipe(
    Effect.map((stdout) => {
      const text = stdout?.trim() ?? "";
      return /^\d+$/.test(text) ? Number(text) : null;
    }),
  );

/**
 * `hermes update` pulls a git checkout and reinstalls its dependencies. Other installs
 * (pip, uv, Docker, Nix) are replaced by the tool that made them, so they stay manual.
 */
export const hermesMaintenance: ProviderMaintenanceCapabilitiesResolver = {
  resolve: Effect.fn("HermesMaintenance.resolve")(function* (context) {
    if (!context) {
      return makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER,
        packageName: null,
      });
    }
    const checkout = [context.resolvedCommandPath, context.realCommandPath].some(
      isNixStoreCommandPath,
    )
      ? null
      : yield* findHermesCheckout(context);
    // An unknown count is treated as unsafe, so a failed check never runs the updater.
    if (checkout === null || (yield* countUnpushedCommits(checkout, context.env)) !== 0) {
      return makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER,
        packageName: null,
        installPath: context.realCommandPath,
        manualCommand: "hermes update",
      });
    }
    return makeProviderMaintenanceCapabilities({
      provider: DRIVER,
      packageName: null,
      updateExecutable: context.resolvedCommandPath,
      // Nothing answers the updater's prompts; --yes takes their defaults instead of blocking.
      updateArgs: ["update", "--yes"],
      updateLockKey: `hermes-git:${normalizeCommandPath(checkout)}`,
      platform: context.platform,
      env: context.env,
    });
  }),
};

export const makeHermesMaintenanceResolution = Effect.fn("HermesMaintenance.make")(function* (
  options: Parameters<typeof resolveProviderMaintenanceCapabilitiesEffect>[1],
) {
  const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
  const client = yield* HttpClient.HttpClient;
  const lookupLatestVersion = client
    .execute(
      HttpClientRequest.get(LATEST_RELEASE).pipe(
        HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
        HttpClientRequest.setHeader("user-agent", "t3code"),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeRelease),
      Effect.map((release) => /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name.trim())?.[1] ?? null),
      Effect.timeoutOption("4 seconds"),
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
  const resolveInstallation = yield* makeCachedProviderMaintenanceResolution(
    resolveProviderMaintenanceCapabilitiesEffect(hermesMaintenance, options).pipe(
      Effect.provideContext(services),
    ),
  );
  const resolve: typeof resolveInstallation = (refreshOptions) =>
    resolveInstallation(refreshOptions).pipe(
      Effect.map((capabilities) => ({
        ...capabilities,
        latestVersion: null,
        latestVersionCacheKey: LATEST_RELEASE,
        lookupLatestVersion,
      })),
    );
  return resolve;
});
