/**
 * DeepSeek Harness provider snapshot.
 *
 * Health comes from `dsh --version` and the sign-in verdict from the harness
 * home, where the API key is kept. Neither starts `dsh --profile acp`, which
 * matters because the health check runs on an interval.
 *
 * dsh has no command that reports whether a key is stored, so the verdict is
 * read the way the harness resolves the key itself: the process environment,
 * then its credential file, then its dotenv file. The key is never sent
 * anywhere by this check, so a stored key that DeepSeek has revoked still reads
 * as signed in until a turn fails.
 *
 * @module provider/Layers/DeepSeekProvider
 */
import * as NodeOS from "node:os";

import {
  DEEPSEEK_DEFAULT_MODEL,
  type CustomModelSetting,
  type DeepSeekSettings,
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { DEEPSEEK_RUNTIME_MODES } from "@t3tools/provider-core/server/runtimeModeSupport";
import { ACP_OPTION_HARNESS_DEFAULT } from "./acp/AcpSessionOption.ts";

const DEEPSEEK_PRESENTATION = {
  runtimeModes: DEEPSEEK_RUNTIME_MODES,
  // The harness says what its session holds of the context window, in `usage_update`.
  reportsContextWindow: true,
  displayName: "DeepSeek",
  badgeLabel: "Early Access",
  // The ACP agent exposes no history rewind, so the UI must not offer one.
  supportsConversationRollback: false,
} as const;

/**
 * The level of reasoning, which the harness offers over ACP as the session option `reasoning_effort`.
 * The values differ with the model, so this list is what the picker shows and no more: a
 * value is sent only when a person chose it and the session offers it.
 */
export const DEEPSEEK_REASONING_OPTION_ID = "reasoning_effort";
export const DEEPSEEK_REASONING_LEVELS = ["off", "low", "high", "max"] as const;

const LEVEL_LABELS: Record<string, string> = { off: "Off", low: "Low", high: "High", max: "Max" };

// Named EMPTY while no option was offered. It now holds the level of reasoning.
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: DEEPSEEK_REASONING_OPTION_ID,
      label: "Reasoning",
      type: "select",
      options: [
        { id: ACP_OPTION_HARNESS_DEFAULT, label: "Harness default", isDefault: true },
        ...DEEPSEEK_REASONING_LEVELS.map((level) => ({
          id: level,
          label: LEVEL_LABELS[level] ?? level,
        })),
      ],
      currentValue: ACP_OPTION_HARNESS_DEFAULT,
    },
  ],
});

// dsh composes its profile before it answers, which takes longer than a plain CLI.
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const API_KEY_NAME = "DEEPSEEK_API_KEY";

/** The models of the harness's official backend, as `session/new` lists them. */
const DEEPSEEK_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEEPSEEK_DEFAULT_MODEL,
    name: "DeepSeek V4 Pro",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/**
 * DeepSeek snapshots advertise `canAuthenticate` so clients can re-check the
 * key from settings. The key is saved from the harness itself (`dsh web`), so
 * the driver's controller verifies rather than signs in, and sign-out has no
 * headless equivalent either. There is no managed runtime to download.
 */
function buildDeepSeekProvider(
  input: Parameters<typeof buildServerProvider>[0],
): ServerProviderDraft {
  return {
    ...buildServerProvider(input),
    setup: { canAuthenticate: true, canInstall: false, canSignOut: false },
  };
}

const runDeepSeekCliCommand = (
  deepseekSettings: DeepSeekSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = deepseekSettings.binaryPath || "dsh";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/** Whether a credential file names a non-empty key under its `refs` section. */
export function credentialFileHoldsApiKey(contents: string): boolean {
  const refs = /^refs:\s*$([\s\S]*?)(?=^\S|(?![\s\S]))/m.exec(contents)?.[1] ?? "";
  const value = new RegExp(`^\\s+${API_KEY_NAME}:\\s*(.*?)\\s*$`, "m").exec(refs)?.[1] ?? "";
  return value.replace(/^(["'])(.*)\1$/, "$2").length > 0;
}

/** Whether a dotenv file sets a non-empty key. */
export function dotenvHoldsApiKey(contents: string): boolean {
  const value =
    new RegExp(`^\\s*(?:export\\s+)?${API_KEY_NAME}\\s*=\\s*(.*?)\\s*$`, "m").exec(contents)?.[1] ??
    "";
  return value.replace(/^(["'])(.*)\1$/, "$2").length > 0;
}

/** Read whether the harness holds a DeepSeek API key. */
export const probeDeepSeekAuthenticated = Effect.fn("probeDeepSeekAuthenticated")(function* (
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
  if (environment[API_KEY_NAME]?.trim()) return true;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home =
    environment.DSH_HOME?.trim() ||
    path.join(environment.HOME || environment.USERPROFILE || NodeOS.homedir(), ".dsh");
  const read = (name: string) =>
    fs.readFileString(path.join(home, name)).pipe(Effect.orElseSucceed(() => ""));
  if (credentialFileHoldsApiKey(yield* read(".credentials.yaml"))) return true;
  return dotenvHoldsApiKey(yield* read(".env"));
});

function deepseekModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting>,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(DEEPSEEK_BUILT_IN_MODELS, customModels, EMPTY_CAPABILITIES);
}

export function buildInitialDeepSeekProviderSnapshot(
  deepseekSettings: DeepSeekSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildDeepSeekProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: deepseekSettings.enabled,
      checkedAt,
      models: deepseekModelsFromSettings(deepseekSettings.customModels),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking DeepSeek Harness CLI…",
      },
    });
  });
}

export const checkDeepSeekProviderStatus = Effect.fn("checkDeepSeekProviderStatus")(function* (
  deepseekSettings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = deepseekModelsFromSettings(deepseekSettings.customModels);
  const build = (probe: Parameters<typeof buildServerProvider>[0]["probe"]) =>
    buildDeepSeekProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: deepseekSettings.enabled,
      checkedAt,
      models,
      probe,
    });

  if (!deepseekSettings.enabled) {
    return build({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "DeepSeek is disabled in T3 Code settings.",
    });
  }

  const versionResult = yield* runDeepSeekCliCommand(
    deepseekSettings,
    ["--version"],
    environment,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("DeepSeek Harness health check failed.", { errorTag: error._tag });
    return build({
      installed: !isCommandMissingCause(error),
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: isCommandMissingCause(error)
        ? "DeepSeek Harness CLI (`dsh`) is not installed or not on PATH."
        : "Failed to execute the DeepSeek Harness CLI health check.",
    });
  }

  if (Option.isNone(versionResult.success)) {
    return build({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "DeepSeek Harness CLI is installed but timed out while running `dsh --version`.",
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("DeepSeek Harness version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
    });
    return build({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "DeepSeek Harness CLI is installed but failed to run.",
    });
  }

  const authenticated = yield* probeDeepSeekAuthenticated(environment);
  const auth: ServerProviderAuth = authenticated
    ? { status: "authenticated", type: "api-key", label: "DeepSeek API key" }
    : { status: "unauthenticated" };
  return build({
    installed: true,
    version,
    status: authenticated ? "ready" : "warning",
    auth,
    ...(authenticated
      ? {}
      : {
          message: "DeepSeek has no API key. Run `dsh web` and save one on its credentials page.",
        }),
  });
});
