/**
 * Usage history for pi: its session files under `<agent dir>/sessions`, and the
 * sessions the delivery engine gives pi for its attempts.
 *
 * @module provider/Drivers/piUsage
 */
import type { UsageTokenTotals } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type ProviderUsageScan,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  makeHarnessFileCache,
  parseLines,
  reportedCost,
  scanHarnessFiles,
} from "./harnessUsageFiles.ts";

/**
 * Parses one line of a pi session file (`<agent dir>/sessions/<cwd>/<time>_<id>.jsonl`,
 * or the session folder the delivery engine gives pi for an attempt).
 *
 * Each assistant message carries the provider and model that answered it and
 * the usage of that one call. pi's `input` excludes the cached input, and its
 * `reasoning` is a part of `output` (its own total adds input, output and the
 * two cache figures only). pi prices the call from its own model table; that
 * figure is kept as the reported cost.
 */
export function parsePiLine(line: string, sessionId: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "message") return null;
  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;
  if (messageRecord["role"] !== "assistant") return null;
  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs =
    parseTimestampMs(record["timestamp"]) ??
    (typeof messageRecord["timestamp"] === "number" ? messageRecord["timestamp"] : null);
  if (timestampMs === null) return null;
  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0) return null;
  const provider = typeof messageRecord["provider"] === "string" ? messageRecord["provider"] : "";

  const outputTokens = tokenCount(usageRecord["output"]);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: tokenCount(usageRecord["input"]),
    cachedInputTokens: tokenCount(usageRecord["cacheRead"]),
    cacheCreationTokens: tokenCount(usageRecord["cacheWrite"]),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usageRecord["reasoning"])),
  };
  if (totalTokens(totals) === 0) return null;
  const cost = usageRecord["cost"];
  const id = typeof record["id"] === "string" ? record["id"] : null;
  return {
    provider: "pi",
    speed: "standard",
    timestampMs,
    model,
    modelProvider: provider.length > 0 ? provider : null,
    modelProviderSource: provider.length > 0 ? "recorded" : null,
    sessionId,
    totals,
    reportedCostUsd:
      typeof cost === "object" && cost !== null
        ? reportedCost((cost as Record<string, unknown>)["total"])
        : null,
    // A session reopened elsewhere keeps its entries' ids.
    dedupeKey: id === null ? null : `pi:${sessionId}:${id}`,
  };
}

/** The session id in a pi session file's name, `<time>_<id>.jsonl`. */
export function piSessionId(filePath: string): string {
  const name =
    filePath
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.jsonl$/, "") ?? "";
  const underscore = name.lastIndexOf("_");
  return underscore >= 0 ? name.slice(underscore + 1) : name;
}

const EngineUsageSources = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({ harness: Schema.String, dir: Schema.String, parentName: Schema.String }),
  ),
});
const decodeEngineUsageSources = Schema.decodeUnknownOption(EngineUsageSources);

const cache = makeHarnessFileCache();

export type PiUsageReaderEnv = FileSystem.FileSystem | Path.Path | HttpClient.HttpClient;

/**
 * pi's own sessions for each instance, then the pi sessions of the delivery
 * engine's attempts, which it keeps in its folder of runs. The engine names
 * them; it is asked only on this host, and only when delivery is on. An engine
 * that does not answer is reported, not guessed at.
 */
export const piUsageReader: ProviderUsageReader<unknown, PiUsageReaderEnv> = {
  kind: "scan",
  provider: "pi",
  scan: Effect.fn("piUsageReader.scan")(function* ({ instances, settings, windowStartMs }) {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const sources = new Map<string, string | undefined>();
    for (const { environment } of instances) {
      const home = expandHomePath(
        environment.PI_CODING_AGENT_DIR?.trim() || path.join(homeDirectory, ".pi", "agent"),
        homeDirectory,
      );
      const dir = path.resolve(home, "sessions");
      sources.set(yield* fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir)), undefined);
    }

    let engineFailure: ProviderUsageScan | null = null;
    const engineUrl = settings.delivery.enabled ? settings.delivery.engineUrl.trim() : "";
    let engineSourcesUrl: string | null = null;
    try {
      const base = new URL(engineUrl);
      if (["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
        engineSourcesUrl = new URL("/api/usage/sources", base).toString();
      }
    } catch {
      engineSourcesUrl = null;
    }
    if (engineSourcesUrl !== null) {
      const httpClient = yield* HttpClient.HttpClient;
      const body = yield* httpClient.get(engineSourcesUrl).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout(3_000),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      const decoded = body === null ? Option.none() : decodeEngineUsageSources(body);
      if (Option.isNone(decoded)) {
        engineFailure = {
          dir: engineUrl,
          volumeId: "",
          files: null,
          status: "failed",
          message:
            "The delivery engine did not name its pi sessions, so pi runs of the engine are not counted.",
        };
      } else {
        for (const source of decoded.value.sources) {
          if (source.harness !== "pi" || source.dir.trim().length === 0) continue;
          const dir = path.resolve(source.dir);
          if (!sources.has(dir)) sources.set(dir, source.parentName);
        }
      }
    }

    const scans: ProviderUsageScan[] = [];
    for (const [dir, parentName] of sources) {
      scans.push(
        yield* scanHarnessFiles(
          {
            dir,
            matches: (filePath) =>
              filePath.endsWith(".jsonl") &&
              (parentName === undefined || path.basename(path.dirname(filePath)) === parentName),
            parse: (text, file) => {
              const sessionId = piSessionId(file.path);
              return parseLines(text, (line) => parsePiLine(line, sessionId));
            },
          },
          windowStartMs,
          cache,
        ),
      );
    }
    if (engineFailure !== null) scans.push(engineFailure);
    return scans;
  }),
};
