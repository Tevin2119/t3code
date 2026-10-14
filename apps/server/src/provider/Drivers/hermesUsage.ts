/**
 * Usage history for Hermes: the per-session model totals in its `state.db`.
 *
 * The store is opened read-only for each read. Hermes writes to it while it
 * runs and is not kept from it. A store that cannot be read is a failed source,
 * never a store without usage.
 *
 * @module provider/Drivers/hermesUsage
 */
import type { HermesSettings, UsageTokenTotals } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type ProviderUsageScan,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { reportedCost } from "./harnessUsageFiles.ts";

type Row = Readonly<Record<string, unknown>>;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/**
 * Hermes keeps the running totals of each session per model and billing
 * provider (`session_model_usage`), not a record of each call. So one row is one
 * record, dated by the last time Hermes used that model in the session: a
 * session that ran over midnight counts on the later day. `input_tokens` is the
 * uncached input and reasoning is a part of the output, as Hermes normalises
 * them. The actual cost is kept when Hermes has one, then its estimate; a row
 * whose cost Hermes does not know has none.
 */
export function hermesRecordFrom(row: Row): UsageRecord | null {
  const model = text(row["model"]);
  const sessionId = text(row["session_id"]);
  if (model === null || sessionId === null) return null;
  const lastSeen = row["last_seen"];
  if (typeof lastSeen !== "number" || !Number.isFinite(lastSeen)) return null;
  const outputTokens = tokenCount(row["output_tokens"]);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: tokenCount(row["input_tokens"]),
    cachedInputTokens: tokenCount(row["cache_read_tokens"]),
    cacheCreationTokens: tokenCount(row["cache_write_tokens"]),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(row["reasoning_tokens"])),
  };
  if (totalTokens(totals) === 0) return null;
  const modelProvider = text(row["billing_provider"]);
  const costKnown = text(row["cost_source"]) !== null && text(row["cost_source"]) !== "none";
  return {
    provider: "hermes",
    speed: "standard",
    timestampMs: Math.round(lastSeen * 1000),
    model,
    modelProvider,
    modelProviderSource: modelProvider === null ? null : "recorded",
    sessionId,
    totals,
    reportedCostUsd: costKnown
      ? (reportedCost(row["actual_cost_usd"]) ?? reportedCost(row["estimated_cost_usd"]))
      : null,
    dedupeKey: `hermes:${sessionId}:${model}:${modelProvider ?? ""}:${text(row["task"]) ?? ""}`,
  };
}

/** The records of `database` last seen at or after `sinceMs`. */
export const readHermesRecords = (database: string, sinceMs: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // A busy Hermes should fail this source promptly rather than stall the scan.
    yield* sql.unsafe("PRAGMA busy_timeout = 100");
    const rows = yield* sql.unsafe<Row>(
      "select session_id, model, billing_provider, task, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd, cost_source, last_seen from session_model_usage where last_seen >= ?",
      [sinceMs / 1000],
    );
    return rows.flatMap((row) => hermesRecordFrom(row) ?? []);
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: database, readonly: true })),
    Effect.orElseSucceed(() => null),
  );

export type HermesUsageReaderEnv = FileSystem.FileSystem | Path.Path;

/** The home of an instance: its setting, then `HERMES_HOME`, then the platform default. */
export const hermesUsageReader: ProviderUsageReader<HermesSettings, HermesUsageReaderEnv> = {
  kind: "scan",
  provider: "hermes",
  scan: Effect.fn("hermesUsageReader.scan")(function* ({ instances, windowStartMs }) {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const homes = new Set<string>();
    for (const { config, environment } of instances) {
      const configured = config?.homePath.trim() ?? "";
      const home = configured
        ? expandHomePath(configured, homeDirectory)
        : environment.HERMES_HOME?.trim() ||
          (environment.LOCALAPPDATA?.trim()
            ? path.join(environment.LOCALAPPDATA.trim(), "hermes")
            : path.join(homeDirectory, ".hermes"));
      const resolved = path.resolve(home);
      homes.add(yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved)));
    }
    return yield* Effect.forEach([...homes], (dir) =>
      Effect.gen(function* () {
        const database = path.join(dir, "state.db");
        const exists = yield* fileSystem.exists(database).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return { dir, files: null } satisfies ProviderUsageScan;
        const records = yield* readHermesRecords(database, windowStartMs);
        return records === null
          ? ({
              dir,
              files: null,
              status: "failed",
              message: "The harness usage store could not be read.",
            } satisfies ProviderUsageScan)
          : ({ dir, files: [{ path: database, records }] } satisfies ProviderUsageScan);
      }),
    );
  }),
};
