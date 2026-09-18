/**
 * DeepSeek provider snapshot.
 *
 * There is no binary to probe and no login to read: the whole health check is
 * `GET /models` with the configured key, which validates the credential and
 * discovers the catalog in one call. A missing key is reported as
 * `unauthenticated` rather than an error, because it is a settings state and
 * not a failure.
 *
 * @module provider/Layers/DeepSeekProvider
 */
import {
  DEEPSEEK_CHAT_MODEL,
  DEEPSEEK_REASONER_MODEL,
  type CustomModelSetting,
  type DeepSeekSettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  listDeepSeekModels,
  resolveDeepSeekCredentials,
  type DeepSeekCredentials,
} from "../deepseek/DeepSeekApi.ts";

const DEEPSEEK_PRESENTATION = {
  displayName: "DeepSeek",
  badgeLabel: "Chat only",
  reportsContextWindow: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const MODEL_PROBE_TIMEOUT_MS = 10_000;

/** Display names for the two models the platform serves. */
const DEEPSEEK_MODEL_NAMES: Readonly<Record<string, string>> = {
  [DEEPSEEK_CHAT_MODEL]: "DeepSeek Chat",
  [DEEPSEEK_REASONER_MODEL]: "DeepSeek Reasoner",
};

const DEEPSEEK_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEEPSEEK_CHAT_MODEL,
    name: DEEPSEEK_MODEL_NAMES[DEEPSEEK_CHAT_MODEL] ?? DEEPSEEK_CHAT_MODEL,
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: DEEPSEEK_REASONER_MODEL,
    name: DEEPSEEK_MODEL_NAMES[DEEPSEEK_REASONER_MODEL] ?? DEEPSEEK_REASONER_MODEL,
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/**
 * Every DeepSeek snapshot declares that it cannot run a thread: the driver
 * backs text generation only, so clients must keep it out of the chat model
 * picker while leaving it selectable for commit and title generation.
 */
function buildDeepSeekProvider(
  input: Parameters<typeof buildServerProvider>[0],
): ServerProviderDraft {
  return {
    ...buildServerProvider(input),
    supportsSessions: false,
    supportsTextGeneration: input.probe.auth.status === "authenticated",
    supportsConversationRollback: false,
  };
}

/**
 * Order the live catalog so the two first-party models lead, then anything else
 * the key can reach (fine-tunes, beta ids). Unknown ids keep their raw name.
 */
export function deepSeekModelsFromCatalog(
  ids: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const ordered = [
    ...DEEPSEEK_BUILT_IN_MODELS.filter((model) => ids.includes(model.slug)),
    ...ids
      .filter((id) => !DEEPSEEK_BUILT_IN_MODELS.some((model) => model.slug === id))
      .map((id): ServerProviderModel => ({
        slug: id,
        name: DEEPSEEK_MODEL_NAMES[id] ?? id,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      })),
  ];
  return ordered.filter((model) => (seen.has(model.slug) ? false : seen.add(model.slug)));
}

function deepSeekModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting>,
  builtIn: ReadonlyArray<ServerProviderModel> = DEEPSEEK_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtIn, customModels, EMPTY_CAPABILITIES);
}

export function buildInitialDeepSeekProviderSnapshot(
  settings: DeepSeekSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildDeepSeekProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: deepSeekModelsFromSettings(settings.customModels),
      probe: {
        // Nothing is installed for an HTTP API; the key is what makes it usable.
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking the DeepSeek API key…",
      },
    });
  });
}

export const checkDeepSeekProviderStatus = Effect.fn("checkDeepSeekProviderStatus")(function* (
  settings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, HttpClient.HttpClient> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = deepSeekModelsFromSettings(settings.customModels);

  if (!settings.enabled) {
    return buildDeepSeekProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "DeepSeek is disabled in T3 Code settings.",
      },
    });
  }

  const credentials: DeepSeekCredentials | undefined = resolveDeepSeekCredentials(
    settings,
    environment,
  );
  if (credentials === undefined) {
    return buildDeepSeekProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unauthenticated" },
        message: "Set a DeepSeek API key in provider settings, or export DEEPSEEK_API_KEY.",
      },
    });
  }

  const probe = yield* listDeepSeekModels(credentials).pipe(
    Effect.timeoutOption(MODEL_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const catalog =
    Result.isSuccess(probe) && Option.isSome(probe.success) ? probe.success.value : undefined;

  if (catalog === undefined) {
    return buildDeepSeekProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Could not reach the DeepSeek API with the configured key.",
      },
    });
  }

  const discovered = deepSeekModelsFromCatalog(catalog);
  return buildDeepSeekProvider({
    presentation: DEEPSEEK_PRESENTATION,
    enabled: true,
    checkedAt,
    models: deepSeekModelsFromSettings(
      settings.customModels,
      discovered.length > 0 ? discovered : DEEPSEEK_BUILT_IN_MODELS,
    ),
    probe: {
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated", type: "api-key", label: "DeepSeek API key" },
    },
  });
});
