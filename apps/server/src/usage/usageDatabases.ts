/**
 * Usage kept in the harnesses' own SQLite stores: OpenCode's `opencode.db` and
 * Hermes's `state.db`.
 *
 * Both are opened for reading only, and closed after each read. The harness
 * writes to its store while it runs and is not kept from it. A store that
 * cannot be read gives `null`, which the scan reports as a failed source, never
 * as a store without usage.
 *
 * @module usageDatabases
 */
import * as NodeSqlite from "node:sqlite";

import type { UsageTokenTotals } from "@t3tools/contracts";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

type Row = Record<string, unknown>;

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/** A cost the harness wrote. Zero is no cost figure: harnesses write it for plans they do not price. */
const costOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

function readRows(file: string, query: string, parameters: ReadonlyArray<number>): Row[] | null {
  let store: NodeSqlite.DatabaseSync;
  try {
    store = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
  try {
    return store.prepare(query).all(...parameters) as Row[];
  } catch {
    return null;
  } finally {
    store.close();
  }
}

/**
 * One record per assistant message of OpenCode, each the usage of one call,
 * with the provider and model OpenCode chose for it. OpenCode counts reasoning
 * beside the output rather than within it, so it is added to the output here,
 * where reasoning is a part of the output. `input` excludes the cache.
 */
export function openCodeRecordFrom(row: Row): UsageRecord | null {
  let message: unknown;
  try {
    message = JSON.parse(String(row["data"]));
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const data = message as Record<string, unknown>;
  if (data["role"] !== "assistant") return null;
  const tokens = data["tokens"];
  if (typeof tokens !== "object" || tokens === null) return null;
  const token = tokens as Record<string, unknown>;
  const cache = (
    typeof token["cache"] === "object" && token["cache"] !== null ? token["cache"] : {}
  ) as Record<string, unknown>;
  const model = text(data["modelID"]);
  if (model === null) return null;
  const modelProvider = text(data["providerID"]);
  const time = data["time"] as Record<string, unknown> | undefined;
  const timestampMs =
    count(time?.["completed"]) || count(time?.["created"]) || count(row["time_created"]);
  if (timestampMs === 0) return null;

  const reasoning = count(token["reasoning"]);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: count(token["input"]),
    cachedInputTokens: count(cache["read"]),
    cacheCreationTokens: count(cache["write"]),
    outputTokens: count(token["output"]) + reasoning,
    reasoningTokens: reasoning,
  };
  if (totalTokens(totals) === 0) return null;
  const id = text(row["id"]);
  return {
    provider: "opencode",
    timestampMs,
    model,
    modelProvider,
    modelProviderSource: modelProvider === null ? null : "recorded",
    sessionId: text(row["session_id"]) ?? "",
    totals,
    reportedCostUsd: costOf(data["cost"]),
    dedupeKey: id === null ? null : `opencode:${id}`,
  };
}

export function readOpenCodeRecords(file: string, sinceMs: number): UsageRecord[] | null {
  const rows = readRows(
    file,
    "select id, session_id, time_created, data from message where time_created >= ? and data like '%\"tokens\"%'",
    [sinceMs],
  );
  if (rows === null) return null;
  return rows.flatMap((row) => openCodeRecordFrom(row) ?? []);
}

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
  const outputTokens = count(row["output_tokens"]);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: count(row["input_tokens"]),
    cachedInputTokens: count(row["cache_read_tokens"]),
    cacheCreationTokens: count(row["cache_write_tokens"]),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, count(row["reasoning_tokens"])),
  };
  if (totalTokens(totals) === 0) return null;
  const modelProvider = text(row["billing_provider"]);
  const costKnown = text(row["cost_source"]) !== null && text(row["cost_source"]) !== "none";
  return {
    provider: "hermes",
    timestampMs: Math.round(lastSeen * 1000),
    model,
    modelProvider,
    modelProviderSource: modelProvider === null ? null : "recorded",
    sessionId,
    totals,
    reportedCostUsd: costKnown
      ? (costOf(row["actual_cost_usd"]) ?? costOf(row["estimated_cost_usd"]))
      : null,
    dedupeKey: `hermes:${sessionId}:${model}:${modelProvider ?? ""}:${text(row["task"]) ?? ""}`,
  };
}

export function readHermesRecords(file: string, sinceMs: number): UsageRecord[] | null {
  const rows = readRows(
    file,
    "select session_id, model, billing_provider, task, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd, cost_source, last_seen from session_model_usage where last_seen >= ?",
    [sinceMs / 1000],
  );
  if (rows === null) return null;
  return rows.flatMap((row) => hermesRecordFrom(row) ?? []);
}
