import type { ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const decodeCache = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ models: Schema.Array(Schema.Unknown) })),
);
const decodeModel = Schema.decodeUnknownOption(
  Schema.Struct({
    slug: Schema.String,
    context_window: Schema.Number,
    max_context_window: Schema.Number,
  }),
);

function validWindow(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

function windowLabel(tokens: number) {
  return tokens >= 1_000_000 && tokens % 1_000_000 === 0
    ? `${tokens / 1_000_000}M`
    : tokens % 1_000 === 0
      ? `${tokens / 1_000}k`
      : tokens.toLocaleString("en-US");
}

/** model/list omits window sizes; use only matching entries from this Codex home's catalog. */
export function applyCodexContextWindows(
  models: ReadonlyArray<ServerProviderModel>,
  cacheText: string,
): ReadonlyArray<ServerProviderModel> {
  const cache = decodeCache(cacheText);
  if (Option.isNone(cache)) return models;
  const windows = new Map(
    cache.value.models.flatMap((entry) => {
      const decoded = decodeModel(entry);
      if (Option.isNone(decoded)) return [];
      const model = decoded.value;
      return validWindow(model.context_window) &&
        validWindow(model.max_context_window) &&
        model.max_context_window > model.context_window
        ? [[model.slug, model] as const]
        : [];
    }),
  );
  return models.map((model) => {
    const window = windows.get(model.slug);
    if (!window) return model;
    return {
      ...model,
      capabilities: {
        ...model.capabilities,
        optionDescriptors: [
          ...(model.capabilities?.optionDescriptors ?? []).filter(
            ({ id }) => id !== "contextWindow",
          ),
          {
            id: "contextWindow",
            label: "Context Window",
            type: "select" as const,
            options: [
              {
                id: String(window.context_window),
                label: windowLabel(window.context_window),
                isDefault: true,
              },
              {
                id: String(window.max_context_window),
                label: windowLabel(window.max_context_window),
              },
            ],
            currentValue: String(window.context_window),
          },
        ],
      },
    };
  });
}

export const enrichCodexContextWindows = Effect.fn("enrichCodexContextWindows")(function* (
  models: ReadonlyArray<ServerProviderModel>,
  codexHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cache = yield* fs
    .readFileString(path.join(codexHome, "models_cache.json"))
    .pipe(Effect.option);
  return Option.isSome(cache) ? applyCodexContextWindows(models, cache.value) : models;
});

export function codexContextWindowConfig(
  selection: Pick<ModelSelection, "model" | "options"> | undefined,
) {
  const value = selection?.options?.find(({ id }) => id === "contextWindow")?.value;
  if (value === undefined) return {};
  const tokens = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!validWindow(tokens)) throw new Error("Invalid Codex context window selection.");
  return { model_context_window: tokens };
}
