/**
 * Usage history for Kimi Code: the `wire.jsonl` log of each agent of a session,
 * under `<home>/sessions/<workspace>/session_<id>/agents/<agent>/`.
 *
 * @module provider/Drivers/kimiUsage
 */
import type { UsageTokenTotals } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeHarnessFileCache, parseLines, scanHarnessFiles } from "./harnessUsageFiles.ts";

/**
 * Parses one line of a Kimi Code session log.
 *
 * Kimi writes a `usage.record` for each call to its model, with the model as
 * Kimi names it: `<provider key>/<model>`, the provider key being the one of
 * Kimi's configuration (`kimi-code`). A model with no provider key, such as the
 * one set by environment for a test, is kept as written, with no provider.
 * `inputOther` is the uncached input. Kimi records no cost.
 */
export function parseKimiLine(line: string, sessionId: string): UsageRecord | null {
  if (!line.includes('"usage.record"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "usage.record") return null;
  const usage = record["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;
  const time = record["time"];
  if (typeof time !== "number" || !Number.isFinite(time)) return null;
  const named = typeof record["model"] === "string" ? record["model"] : "";
  if (named.length === 0) return null;
  const slash = named.indexOf("/");
  const modelProvider = slash > 0 ? named.slice(0, slash) : null;
  const model = slash > 0 ? named.slice(slash + 1) : named;

  const totals: UsageTokenTotals = {
    uncachedInputTokens: tokenCount(usageRecord["inputOther"]),
    cachedInputTokens: tokenCount(usageRecord["inputCacheRead"]),
    cacheCreationTokens: tokenCount(usageRecord["inputCacheCreation"]),
    outputTokens: tokenCount(usageRecord["output"]),
    reasoningTokens: 0,
  };
  if (totalTokens(totals) === 0) return null;
  return {
    provider: "kimi",
    speed: "standard",
    timestampMs: time,
    model,
    modelProvider,
    modelProviderSource: modelProvider === null ? null : "recorded",
    sessionId,
    totals,
    reportedCostUsd: null,
    // One log per agent, written by that agent only.
    dedupeKey: null,
  };
}

/**
 * A Kimi session is its `session_<id>` folder, not the folder of one of its
 * agents. Split by hand: a path written on Windows keeps its backslashes on any host.
 */
export function kimiSessionId(filePath: string): string {
  const folders = filePath.split(/[\\/]/).slice(0, -1);
  return folders.findLast((folder) => folder.startsWith("session_")) ?? folders.at(-1) ?? "";
}

const cache = makeHarnessFileCache();

export type KimiUsageReaderEnv = FileSystem.FileSystem | Path.Path;

export const kimiUsageReader: ProviderUsageReader<unknown, KimiUsageReaderEnv> = {
  kind: "scan",
  provider: "kimi",
  scan: Effect.fn("kimiUsageReader.scan")(function* ({ instances, windowStartMs }) {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const dirs = new Set<string>();
    for (const { environment } of instances) {
      const home = expandHomePath(
        environment.KIMI_CODE_HOME?.trim() || path.join(homeDirectory, ".kimi-code"),
        homeDirectory,
      );
      const dir = path.resolve(home, "sessions");
      dirs.add(yield* fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir)));
    }
    return yield* Effect.forEach([...dirs], (dir) =>
      scanHarnessFiles(
        {
          dir,
          matches: (filePath) => path.basename(filePath) === "wire.jsonl",
          parse: (text, file) => {
            const sessionId = kimiSessionId(file.path);
            return parseLines(text, (line) => parseKimiLine(line, sessionId));
          },
        },
        windowStartMs,
        cache,
      ),
    );
  }),
};
