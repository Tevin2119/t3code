/**
 * Kimi Code provider snapshot.
 *
 * Health, auth and model discovery all come from the CLI without starting an
 * agent: `kimi --version` for the install probe and `kimi provider list --json`
 * for the configured providers and their model catalog. Neither spawns the ACP
 * server, which matters because the health check runs on an interval.
 *
 * @module provider/Layers/KimiProvider
 */
import type {
  CustomModelSetting,
  KimiSettings,
  ModelCapabilities,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { KIMI_DEFAULT_MODEL_SLUG } from "../acp/KimiAcpSupport.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const KIMI_PRESENTATION = {
  displayName: "Kimi",
  badgeLabel: "Early Access",
  // The ACP agent exposes no history rewind, so the UI must not offer one.
  supportsConversationRollback: false,
  reportsContextWindow: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const VERSION_PROBE_TIMEOUT_MS = 4_000;

/**
 * Fallback catalog used before the CLI answers, or when it cannot be reached.
 * The live list from `kimi provider list --json` replaces this whenever the
 * probe succeeds.
 */
const KIMI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: KIMI_DEFAULT_MODEL_SLUG,
    name: "K2.7 Coding",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/**
 * Shape of `kimi provider list --json`. Only the fields the snapshot reads are
 * declared; the CLI adds more (base URLs, credentials) that must not leak into
 * the snapshot.
 */
const KimiProviderCatalog = Schema.Struct({
  providers: Schema.Record(
    Schema.String,
    Schema.Struct({
      type: Schema.optional(Schema.String),
      apiKey: Schema.optional(Schema.String),
      oauth: Schema.optional(Schema.Unknown),
    }),
  ),
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      provider: Schema.optional(Schema.String),
      displayName: Schema.optional(Schema.String),
    }),
  ),
});

const decodeKimiProviderCatalog = Schema.decodeUnknownOption(KimiProviderCatalog);

export interface KimiCatalog {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly auth: ServerProviderAuth;
}

/**
 * Turn the CLI's provider config into a model list and a login verdict. A
 * provider entry carrying either an `oauth` block or a non-empty `apiKey`
 * counts as signed in; an empty provider map means the CLI is installed but
 * never logged in.
 */
export function parseKimiProviderCatalog(output: string): KimiCatalog | undefined {
  const parsed = Option.getOrUndefined(
    decodeKimiProviderCatalog(Option.getOrUndefined(parseJson(output))),
  );
  if (parsed === undefined) return undefined;

  const credentialed = Object.values(parsed.providers).filter(
    (provider) => provider.oauth !== undefined || (provider.apiKey ?? "").trim().length > 0,
  );
  const usesOauth = credentialed.some((provider) => provider.oauth !== undefined);
  const models = Object.entries(parsed.models).map(([slug, model]): ServerProviderModel => ({
    slug,
    name: model.displayName?.trim() || slug,
    isCustom: false,
    ...(slug === KIMI_DEFAULT_MODEL_SLUG ? { isDefault: true } : {}),
    capabilities: EMPTY_CAPABILITIES,
  }));
  return {
    models,
    auth:
      credentialed.length > 0
        ? {
            status: "authenticated",
            type: usesOauth ? "oauth" : "api-key",
            label: usesOauth ? "Kimi account" : "API key",
          }
        : { status: "unauthenticated" },
  };
}

function parseJson(output: string): Option.Option<unknown> {
  // The CLI prints the JSON document on its own, but a stray banner line before
  // it must not poison the parse.
  const start = output.indexOf("{");
  if (start < 0) return Option.none();
  try {
    return Option.some(JSON.parse(output.slice(start)) as unknown);
  } catch {
    return Option.none();
  }
}

/**
 * Every Kimi snapshot advertises `canAuthenticate` so clients render the
 * sign-in affordance: the driver owns a device-code controller that runs
 * `kimi login`. There is no managed runtime to download, so `canInstall`
 * stays false and the CLI has to be installed by the user.
 */
function buildKimiProvider(input: Parameters<typeof buildServerProvider>[0]): ServerProviderDraft {
  return {
    ...buildServerProvider(input),
    setup: { canAuthenticate: true, canInstall: false },
  };
}

const runKimiCliCommand = (
  kimiSettings: KimiSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = kimiSettings.binaryPath || "kimi";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

function kimiModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting>,
  builtIn: ReadonlyArray<ServerProviderModel> = KIMI_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtIn, customModels, EMPTY_CAPABILITIES);
}

/**
 * Read whether the CLI currently holds usable credentials. Used by the auth
 * controller after a sign-in or sign-out, where the full status probe would
 * re-run the version check for nothing.
 */
export const probeKimiAuthenticated = Effect.fn("probeKimiAuthenticated")(function* (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<boolean, never, ChildProcessSpawner.ChildProcessSpawner> {
  const result = yield* runKimiCliCommand(
    kimiSettings,
    ["provider", "list", "--json"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(result) || Option.isNone(result.success)) return false;
  if (result.success.value.code !== 0) return false;
  return parseKimiProviderCatalog(result.success.value.stdout)?.auth.status === "authenticated";
});

export function buildInitialKimiProviderSnapshot(
  kimiSettings: KimiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildKimiProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: kimiModelsFromSettings(kimiSettings.customModels),
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Kimi Code CLI…",
      },
    });
  });
}

export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(function* (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = kimiModelsFromSettings(kimiSettings.customModels);

  if (!kimiSettings.enabled) {
    return buildKimiProvider({
      presentation: KIMI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kimi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runKimiCliCommand(kimiSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Kimi CLI health check failed.", { errorTag: error._tag });
    return buildKimiProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Kimi Code CLI (`kimi`) is not installed or not on PATH."
          : "Failed to execute the Kimi Code CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildKimiProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code CLI is installed but timed out while running `kimi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Kimi CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
    });
    return buildKimiProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code CLI is installed but failed to run.",
      },
    });
  }

  // `kimi provider list --json` reports credentials and the model catalog
  // without starting the agent.
  const catalogResult = yield* runKimiCliCommand(
    kimiSettings,
    ["provider", "list", "--json"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);

  // Only a clean exit is parsed: a failed invocation prints help or error text
  // that must not be read as a model catalog or a login verdict.
  const catalog =
    Result.isSuccess(catalogResult) &&
    Option.isSome(catalogResult.success) &&
    catalogResult.success.value.code === 0
      ? parseKimiProviderCatalog(catalogResult.success.value.stdout)
      : undefined;

  if (catalog === undefined) {
    return buildKimiProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not read Kimi providers. Run `kimi login` if sign-in has expired.",
      },
    });
  }

  const models = kimiModelsFromSettings(
    kimiSettings.customModels,
    catalog.models.length > 0 ? catalog.models : KIMI_BUILT_IN_MODELS,
  );
  const authenticated = catalog.auth.status === "authenticated";
  return buildServerProvider({
    presentation: KIMI_PRESENTATION,
    enabled: kimiSettings.enabled,
    checkedAt,
    models,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      status: authenticated ? "ready" : "warning",
      auth: catalog.auth,
      ...(authenticated ? {} : { message: "Sign in with `kimi login` to use Kimi in T3 Code." }),
    },
  });
});
