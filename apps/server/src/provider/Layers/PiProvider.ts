/**
 * pi provider snapshot.
 *
 * Every probe is a short-lived CLI call that never starts an agent session:
 * `pi --version` for the install check, `pi auth check --json` for the login
 * verdict, and `pi --list-models <provider>` for the catalog.
 *
 * `pi auth check` is the only first-party way to read login state — pi stores
 * credentials per backend provider (`kimi-coding`, `openai-codex`, …) rather
 * than per account, so the configured provider id decides what is probed.
 *
 * @module provider/Layers/PiProvider
 */
import type {
  CustomModelSetting,
  ModelCapabilities,
  PiSettings,
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

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PI_PRESENTATION = {
  displayName: "pi",
  badgeLabel: "Early Access",
  // pi's RPC mode exposes no history rewind.
  supportsConversationRollback: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_PROBE_TIMEOUT_MS = 15_000;

/** Fallback shown before the CLI answers, or when the catalog probe fails. */
const PI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "kimi-coding/kimi-for-coding",
    name: "kimi-for-coding",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/**
 * Shape of `pi auth check --provider <id> --json`. `status` is `ready` once the
 * provider has usable credentials; anything else carries a `reason` such as
 * `provider_not_found` or `credentials_not_configured`.
 */
const PiAuthCheck = Schema.Struct({
  status: Schema.String,
  provider: Schema.optional(Schema.String),
  authType: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});

const decodePiAuthCheck = Schema.decodeUnknownOption(PiAuthCheck);

export function parsePiAuthCheck(output: string): ServerProviderAuth | undefined {
  const start = output.indexOf("{");
  if (start < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start)) as unknown;
  } catch {
    return undefined;
  }
  const decoded = Option.getOrUndefined(decodePiAuthCheck(parsed));
  if (decoded === undefined) return undefined;
  if (decoded.status !== "ready") {
    return { status: "unauthenticated" };
  }
  const authType = decoded.authType?.trim();
  return {
    status: "authenticated",
    ...(authType ? { type: authType } : {}),
    ...(authType === "oauth" ? { label: "Moonshot account" } : {}),
  };
}

/**
 * Parse the aligned table `pi --list-models` prints. Columns are separated by
 * runs of two or more spaces; the first row is a header and is skipped.
 * Slugs are emitted in pi's own `provider/id` form, which is what `--model`
 * accepts and what the model picker stores.
 */
export function parsePiModelsOutput(output: string): ReadonlyArray<ServerProviderModel> {
  const models: Array<ServerProviderModel> = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0) continue;
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length < 2) continue;
    const provider = columns[0]?.trim();
    const model = columns[1]?.trim();
    if (!provider || !model) continue;
    // Header row.
    if (provider === "provider" && model === "model") continue;
    const slug = `${provider}/${model}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: model,
      subProvider: provider,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return models;
}

/**
 * pi snapshots advertise `canAuthenticate` so clients can re-check credentials
 * from settings. pi's own sign-in only exists inside its TUI (`/login`), so the
 * driver's controller verifies rather than signs in, and there is no managed
 * runtime to install.
 */
function buildPiProvider(input: Parameters<typeof buildServerProvider>[0]): ServerProviderDraft {
  return {
    ...buildServerProvider(input),
    // pi's `/logout` is a TUI command with no headless equivalent, so clients
    // must not offer a sign-out button that can only fail.
    setup: { canAuthenticate: true, canInstall: false, canSignOut: false },
  };
}

const runPiCliCommand = (
  piSettings: PiSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = piSettings.binaryPath || "pi";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

function piModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting>,
  builtIn: ReadonlyArray<ServerProviderModel> = PI_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtIn, customModels, EMPTY_CAPABILITIES);
}

/**
 * Read whether the configured pi provider currently has usable credentials.
 * `pi auth check` refreshes an expired OAuth token as a side effect, which is
 * exactly what the auth controller wants before it reports a verdict.
 */
export const probePiAuthenticated = Effect.fn("probePiAuthenticated")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<boolean, never, ChildProcessSpawner.ChildProcessSpawner> {
  const provider = piSettings.provider.trim() || "kimi-coding";
  const result = yield* runPiCliCommand(
    piSettings,
    ["auth", "check", "--provider", provider, "--json"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(result) || Option.isNone(result.success)) return false;
  // `pi auth check` exits non-zero when the provider is not ready and still
  // prints the verdict, so the payload decides rather than the exit code.
  return parsePiAuthCheck(result.success.value.stdout)?.status === "authenticated";
});

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildPiProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: piModelsFromSettings(piSettings.customModels),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking pi CLI…",
      },
    });
  });
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(piSettings.customModels);
  const provider = piSettings.provider.trim() || "kimi-coding";

  if (!piSettings.enabled) {
    return buildPiProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runPiCliCommand(piSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("pi CLI health check failed.", { errorTag: error._tag });
    return buildPiProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "pi CLI (`pi`) is not installed or not on PATH."
          : "Failed to execute the pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildPiProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("pi CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
    });
    return buildPiProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "pi CLI is installed but failed to run.",
      },
    });
  }

  const authResult = yield* runPiCliCommand(
    piSettings,
    ["auth", "check", "--provider", provider, "--json"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);

  // `pi auth check` exits non-zero when the provider is not ready, and still
  // prints the JSON verdict, so the payload is parsed regardless of exit code.
  const auth =
    Result.isSuccess(authResult) && Option.isSome(authResult.success)
      ? parsePiAuthCheck(authResult.success.value.stdout)
      : undefined;

  const modelsResult = yield* runPiCliCommand(
    piSettings,
    ["--list-models", provider],
    environment,
  ).pipe(Effect.timeoutOption(MODEL_PROBE_TIMEOUT_MS), Effect.result);

  const discoveredModels =
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? parsePiModelsOutput(modelsResult.success.value.stdout)
      : [];

  const models = piModelsFromSettings(
    piSettings.customModels,
    discoveredModels.length > 0 ? discoveredModels : PI_BUILT_IN_MODELS,
  );

  if (auth === undefined) {
    return buildPiProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: `Could not read pi auth state for provider '${provider}'.`,
      },
    });
  }

  const authenticated = auth.status === "authenticated";
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: authenticated ? "ready" : "warning",
      auth,
      ...(authenticated
        ? {}
        : { message: `Sign in to pi provider '${provider}' to use it in T3 Code.` }),
    },
  });
});
