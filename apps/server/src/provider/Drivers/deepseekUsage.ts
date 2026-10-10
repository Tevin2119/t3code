/**
 * Usage history for the DeepSeek harness: the running totals of each session in
 * its store, `<home>/storages/session_projcache/sessions/<id>.json`.
 *
 * @module provider/Drivers/deepseekUsage
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

import { makeHarnessFileCache, scanHarnessFiles } from "./harnessUsageFiles.ts";

/**
 * The model a DeepSeek session ran on. The DeepSeek harness keeps the tokens of a session and
 * not the model that used them, so its usage is shown under this name and is never priced.
 */
export const DEEPSEEK_MODEL_NOT_RECORDED = "model not recorded by DeepSeek";

/**
 * A session of the DeepSeek harness, from its own store. The store holds the
 * running totals of the session, not a record of each turn. So a session is one
 * record, dated by the last time the harness wrote it: a session that ran over
 * midnight counts on the later day.
 */
export function parseDeepSeekSession(
  text: string,
  sessionId: string,
  lastWrittenMs: number,
): UsageRecord | null {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  const record = (
    document as { record?: { rows?: { tokenUsage?: { val?: { totals?: unknown } } } } }
  )?.record;
  const totals = record?.rows?.tokenUsage?.val?.totals as Record<string, unknown> | undefined;
  if (!totals || typeof totals !== "object") return null;
  const usage: UsageTokenTotals = {
    uncachedInputTokens: tokenCount(totals.uncachedInputTokens),
    cachedInputTokens: tokenCount(totals.cacheReadTokens),
    cacheCreationTokens: tokenCount(totals.cacheWriteTokens),
    outputTokens: tokenCount(totals.outputTokens),
    reasoningTokens: 0,
  };
  if (totalTokens(usage) === 0) return null;
  return {
    provider: "deepseek",
    speed: "standard",
    timestampMs: lastWrittenMs,
    model: DEEPSEEK_MODEL_NOT_RECORDED,
    // Nor the provider: the harness can be pointed at another endpoint.
    modelProvider: null,
    modelProviderSource: null,
    sessionId,
    totals: usage,
    reportedCostUsd: null,
    dedupeKey: `deepseek:${sessionId}`,
  };
}

const cache = makeHarnessFileCache();

export type DeepSeekUsageReaderEnv = FileSystem.FileSystem | Path.Path;

export const deepseekUsageReader: ProviderUsageReader<unknown, DeepSeekUsageReaderEnv> = {
  kind: "scan",
  provider: "deepseek",
  scan: Effect.fn("deepseekUsageReader.scan")(function* ({ instances, windowStartMs }) {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const dirs = new Set<string>();
    for (const { environment } of instances) {
      const home = expandHomePath(
        environment.DSH_HOME?.trim() || path.join(homeDirectory, ".dsh"),
        homeDirectory,
      );
      const dir = path.resolve(home, "storages", "session_projcache", "sessions");
      dirs.add(yield* fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir)));
    }
    return yield* Effect.forEach([...dirs], (dir) =>
      scanHarnessFiles(
        {
          dir,
          matches: (filePath) => filePath.endsWith(".json"),
          parse: (text, file) => {
            const record = parseDeepSeekSession(
              text,
              path.basename(file.path, ".json"),
              file.mtimeMs,
            );
            return record === null ? [] : [record];
          },
        },
        windowStartMs,
        cache,
      ),
    );
  }),
};
