/**
 * Hermes Agent provider snapshot.
 *
 * Health, credentials and the configured model all come from short CLI calls
 * rather than the agent: `hermes --version` for the install probe,
 * `hermes config get model.provider` / `model.default` for what Hermes will
 * run, and `hermes auth status <provider>` for the sign-in verdict. None of
 * them start `hermes acp`, which matters because the health check runs on an
 * interval and the ACP agent loads the machine's whole tool and MCP surface
 * before it answers.
 *
 * Hermes fronts an inference provider chosen on the host (DeepSeek on a
 * default install), so the model catalog is that one pair, published under the
 * `provider:model` id Hermes itself uses over ACP.
 *
 * @module provider/Layers/HermesProvider
 */
import {
  HERMES_DEFAULT_MODEL,
  type CustomModelSetting,
  type HermesSettings,
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { hermesModelSlug } from "../acp/HermesAcpSupport.ts";
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

const HERMES_PRESENTATION = {
  displayName: "Hermes",
  badgeLabel: "Early Access",
  // The ACP agent exposes no history rewind, so the UI must not offer one.
  supportsConversationRollback: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const VERSION_PROBE_TIMEOUT_MS = 4_000;

/**
 * Stand-in used before the CLI answers, or when its config cannot be read. The
 * slug is the alias that means "whatever Hermes is configured with", so picking
 * it sends no model id over ACP.
 */
const HERMES_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: HERMES_DEFAULT_MODEL,
    name: "Hermes default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export interface HermesRuntimeConfig {
  readonly provider: string;
  readonly model: string;
}

/** `hermes config get <key>` prints the resolved value, or exits non-zero. */
export function parseHermesConfigValue(output: string): string | undefined {
  const value = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return value && value !== "None" ? value : undefined;
}

/** `hermes auth status <provider>` prints "<provider>: logged in" or "… logged out". */
export function parseHermesAuthStatus(output: string): boolean {
  return /:\s*logged in\b/i.test(output);
}

/**
 * The configured pair as the one built-in model. It carries the default alias
 * so a thread that never picked a model resolves to it, and `provider:model` is
 * the id `hermes acp` reports and accepts.
 */
export function hermesModelsFromRuntimeConfig(
  runtime: HermesRuntimeConfig | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (runtime === undefined) return HERMES_FALLBACK_MODELS;
  const slug = hermesModelSlug(runtime.provider, runtime.model);
  if (!slug) return HERMES_FALLBACK_MODELS;
  return [
    {
      slug,
      name: runtime.model,
      isCustom: false,
      isDefault: true,
      aliases: [HERMES_DEFAULT_MODEL],
      capabilities: EMPTY_CAPABILITIES,
    },
  ];
}

/**
 * Hermes snapshots advertise `canAuthenticate` so clients can re-check
 * credentials from settings. Signing in means running Hermes' own setup wizard
 * in a terminal (`hermes acp --setup`), so the driver's controller verifies
 * rather than signs in, and sign-out has no headless equivalent either. There
 * is no managed runtime to download, so `canInstall` stays false.
 */
function buildHermesProvider(
  input: Parameters<typeof buildServerProvider>[0],
): ServerProviderDraft {
  return {
    ...buildServerProvider(input),
    setup: { canAuthenticate: true, canInstall: false, canSignOut: false },
  };
}

const runHermesCliCommand = (
  hermesSettings: HermesSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = hermesSettings.binaryPath || "hermes";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/** Stdout of a CLI call that exited cleanly within the probe budget. */
const runHermesCliValue = Effect.fn("runHermesCliValue")(function* (
  hermesSettings: HermesSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string | undefined, never, ChildProcessSpawner.ChildProcessSpawner> {
  const result = yield* runHermesCliCommand(hermesSettings, args, environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(result) || Option.isNone(result.success)) return undefined;
  if (result.success.value.code !== 0) return undefined;
  return result.success.value.stdout;
});

/** What `hermes acp` will run: the provider it authenticates with and its model. */
export const readHermesRuntimeConfig = Effect.fn("readHermesRuntimeConfig")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  HermesRuntimeConfig | undefined,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const provider = parseHermesConfigValue(
    (yield* runHermesCliValue(hermesSettings, ["config", "get", "model.provider"], environment)) ??
      "",
  );
  if (provider === undefined) return undefined;
  const model = parseHermesConfigValue(
    (yield* runHermesCliValue(hermesSettings, ["config", "get", "model.default"], environment)) ??
      "",
  );
  return model === undefined ? undefined : { provider, model };
});

/**
 * Read whether Hermes holds usable credentials for its configured provider.
 * Used by the auth controller, where the full status probe would re-run the
 * version check for nothing.
 */
export const probeHermesAuthenticated = Effect.fn("probeHermesAuthenticated")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<boolean, never, ChildProcessSpawner.ChildProcessSpawner> {
  const runtime = yield* readHermesRuntimeConfig(hermesSettings, environment);
  if (runtime === undefined) return false;
  const status = yield* runHermesCliValue(
    hermesSettings,
    ["auth", "status", runtime.provider],
    environment,
  );
  return status === undefined ? false : parseHermesAuthStatus(status);
});

function hermesModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting>,
  builtIn: ReadonlyArray<ServerProviderModel> = HERMES_FALLBACK_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtIn, customModels, EMPTY_CAPABILITIES);
}

export function buildInitialHermesProviderSnapshot(
  hermesSettings: HermesSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildHermesProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: hermesModelsFromSettings(hermesSettings.customModels),
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Hermes Agent CLI…",
      },
    });
  });
}

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = hermesModelsFromSettings(hermesSettings.customModels);

  if (!hermesSettings.enabled) {
    return buildHermesProvider({
      presentation: HERMES_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runHermesCliCommand(hermesSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Hermes CLI health check failed.", { errorTag: error._tag });
    return buildHermesProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Hermes Agent CLI (`hermes`) is not installed or not on PATH."
          : "Failed to execute the Hermes Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildHermesProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes Agent CLI is installed but timed out while running `hermes --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Hermes CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
    });
    return buildHermesProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes Agent CLI is installed but failed to run.",
      },
    });
  }

  const runtime = yield* readHermesRuntimeConfig(hermesSettings, environment);
  if (runtime === undefined) {
    return buildHermesProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes has no provider configured. Run `hermes acp --setup` to choose one.",
      },
    });
  }

  const models = hermesModelsFromSettings(
    hermesSettings.customModels,
    hermesModelsFromRuntimeConfig(runtime),
  );
  const status = yield* runHermesCliValue(
    hermesSettings,
    ["auth", "status", runtime.provider],
    environment,
  );
  if (status === undefined) {
    return buildHermesProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: `Could not read Hermes credentials for '${runtime.provider}'.`,
      },
    });
  }

  const authenticated = parseHermesAuthStatus(status);
  const auth: ServerProviderAuth = authenticated
    ? { status: "authenticated", type: "api-key", label: `${runtime.provider} credentials` }
    : { status: "unauthenticated" };
  return buildHermesProvider({
    presentation: HERMES_PRESENTATION,
    enabled: hermesSettings.enabled,
    checkedAt,
    models,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      status: authenticated ? "ready" : "warning",
      auth,
      ...(authenticated
        ? {}
        : {
            message: `Hermes has no credentials for '${runtime.provider}'. Run \`hermes acp --setup\` to sign in.`,
          }),
    },
  });
});
