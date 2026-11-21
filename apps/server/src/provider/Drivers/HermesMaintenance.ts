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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const DRIVER = ProviderDriverKind.make("hermes");
// PyPI's `hermes-agent` lags the releases and npm's is an unofficial bridge.
const LATEST_RELEASE = "https://api.github.com/repos/NousResearch/hermes-agent/releases/latest";
const decodeRelease = Schema.decodeUnknownEffect(Schema.Struct({ tag_name: Schema.String }));

/**
 * The checkout a Hermes launcher runs, or null. The official installer clones the repository
 * and runs it from `<checkout>/venv`, with a launcher in a `bin` beside the checkout on Windows.
 */
const findHermesCheckout = Effect.fn("HermesMaintenance.findCheckout")(function* (
  context: ProviderMaintenanceResolutionContext,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const commandPath of [context.realCommandPath, context.resolvedCommandPath]) {
    const binDirectory = path.dirname(commandPath);
    const parent = path.dirname(binDirectory);
    const candidates = [
      ...(path.basename(parent).toLowerCase() === "venv" ? [path.dirname(parent)] : []),
      path.join(parent, "hermes-agent"),
    ];
    for (const candidate of candidates) {
      const isCheckout = yield* Effect.all([
        fs.exists(path.join(candidate, ".git")),
        fs.exists(path.join(candidate, "pyproject.toml")),
      ]).pipe(
        Effect.map((found) => found.every(Boolean)),
        Effect.orElseSucceed(() => false),
      );
      if (isCheckout) return candidate;
    }
  }
  return null;
});

/**
 * `hermes update` pulls a git checkout and reinstalls its dependencies. Other installs
 * (pip, uv, Docker, Nix) are replaced by the tool that made them, so they stay manual.
 */
export const hermesMaintenance: ProviderMaintenanceCapabilitiesResolver = {
  resolve: Effect.fn("HermesMaintenance.resolve")(function* (context) {
    if (!context) {
      return makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER, packageName: null });
    }
    const checkout = [context.resolvedCommandPath, context.realCommandPath].some(
      isNixStoreCommandPath,
    )
      ? null
      : yield* findHermesCheckout(context);
    if (checkout === null) {
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
