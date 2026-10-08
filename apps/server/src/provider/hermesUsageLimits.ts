/**
 * Hermes subscription usage. Hermes fronts whichever inference provider the
 * host selected, so limits exist only for a provider that sells a plan with
 * rolling windows. Today that is Z.AI (GLM).
 *
 * @module provider/Layers/hermesUsageLimits
 */
import * as NodeOS from "node:os";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeUnavailableUsageLimits } from "./providerUsageLimits.ts";
import { fetchZaiUsageLimits, zaiOriginForBaseUrl } from "./zaiUsageLimits.ts";

const ZAI_KEY_NAMES = ["GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"] as const;

/** Values of a dotenv file, without export prefixes, quotes or comments. */
export function parseDotenv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, name, raw] = match;
    if (name === undefined || raw === undefined) continue;
    const quoted = /^(["'])(.*)\1$/.exec(raw);
    values[name] = quoted?.[2] ?? raw.replace(/\s+#.*$/, "");
  }
  return values;
}

/** Hermes keeps its home under `%LOCALAPPDATA%`, which only Windows sets, and `~/.hermes` elsewhere. */
function hermesHome(environment: NodeJS.ProcessEnv, path: Path.Path): string {
  const configured = environment.HERMES_HOME?.trim();
  if (configured) return configured;
  const localAppData = environment.LOCALAPPDATA?.trim();
  if (localAppData) return path.join(localAppData, "hermes");
  return path.join(environment.HOME || environment.USERPROFILE || NodeOS.homedir(), ".hermes");
}

export const readHermesUsageLimits = Effect.fn("readHermesUsageLimits")(function* (input: {
  /** The provider `hermes config get model.provider` reports. */
  readonly provider: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (input.provider !== "zai") return unsupported;

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const contents = yield* fs
      .readFileString(path.join(hermesHome(input.environment, path), ".env"))
      .pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
        }),
      );
    const stored = parseDotenv(contents);
    // Hermes lets the process environment override its own dotenv file.
    const apiKey = ZAI_KEY_NAMES.map(
      (name) => input.environment[name]?.trim() || stored[name]?.trim(),
    ).find((value) => value);
    if (!apiKey) return unsupported;
    const baseUrl = input.environment.GLM_BASE_URL?.trim() || stored.GLM_BASE_URL?.trim();
    return yield* fetchZaiUsageLimits({
      apiKey,
      origin: zaiOriginForBaseUrl(baseUrl),
      checkedAt,
    });
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Hermes could not read usage limits.",
      }),
    ),
  );
});
