/**
 * Usage kept by Antigravity. Its CLI (`agy`) and the runtime T3 runs for an
 * Antigravity instance keep each conversation in a SQLite database of its own,
 * `conversations/<conversation id>.db`.
 *
 * The rows are protocol buffers whose schema Google does not publish. Only the
 * fields below are read, as agy 1.2.16 wrote them on 7 October 2026. The usage
 * of each model call matched, field for field, the `usage` agy printed in its
 * stream for the same call.
 *
 * - `steps.metadata`, field 9: the usage of the model call the step is. 2 is the
 *   uncached input, 5 the input read from the cache, 3 the output with its
 *   thinking, 9 the thinking.
 * - `steps.metadata`, fields 8, 7, 6, 1: times, as `{1: seconds, 2: nanos}`;
 *   8 is when the step finished.
 * - `executor_metadata.data`, 10.1.28: the model the conversation was started
 *   on, its reasoning level at the end of the name (`gemini-3.8-flash-high`).
 * - `gen_metadata.data`, 1.19: the model's name as the service gave it, used
 *   only when the conversation names none.
 *
 * A conversation whose model is changed part way counts under the model it
 * names last. A store that cannot be read gives `null`, never a store without
 * usage.
 *
 * @module antigravityUsage
 */
import * as NodeSqlite from "node:sqlite";

import type { UsageTokenTotals } from "@t3tools/contracts";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

/** Shown for a conversation that names no model. Never priced. */
export const ANTIGRAVITY_MODEL_NOT_RECORDED = "model not recorded by Antigravity";

/**
 * The model provider of Antigravity's usage. With a Google account the tokens
 * come out of the account's plan (`antigravity`); an API key or Agent Platform
 * bills them, at Gemini's or Vertex AI's rates.
 */
export type AntigravityBilling = "antigravity" | "gemini" | "vertex_ai";

/** The levels Antigravity puts at the end of a model's name. */
const LEVEL_SUFFIX = /-(minimal|low|medium|high|xhigh|max)$/u;

interface Field {
  readonly number: number;
  readonly varint: number | null;
  readonly bytes: Uint8Array | null;
}

/** The fields of one message, or `null` when the bytes are not one. */
function fieldsOf(bytes: Uint8Array): Field[] | null {
  const fields: Field[] = [];
  let at = 0;
  const varint = (): number | null => {
    let value = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      if (at >= bytes.length) return null;
      const byte = bytes[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    return null;
  };
  while (at < bytes.length) {
    const key = varint();
    if (key === null) return null;
    const number = Math.floor(key / 8);
    const wire = key % 8;
    if (number === 0) return null;
    if (wire === 0) {
      const value = varint();
      if (value === null) return null;
      fields.push({ number, varint: value, bytes: null });
    } else if (wire === 2) {
      const length = varint();
      if (length === null || at + length > bytes.length) return null;
      fields.push({ number, varint: null, bytes: bytes.subarray(at, at + length) });
      at += length;
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4;
      if (at > bytes.length) return null;
    } else {
      return null;
    }
  }
  return fields;
}

/** The last message at `path`, the way a reader of the schema would see a repeated field. */
function messageAt(bytes: Uint8Array, path: readonly number[]): Uint8Array | null {
  let current: Uint8Array | null = bytes;
  for (const number of path) {
    const fields: Field[] | null = current === null ? null : fieldsOf(current);
    current = fields?.findLast((field) => field.number === number)?.bytes ?? null;
    if (current === null) return null;
  }
  return current;
}

function numberAt(bytes: Uint8Array | null, number: number): number {
  if (bytes === null) return 0;
  const value = fieldsOf(bytes)?.findLast((field) => field.number === number)?.varint ?? 0;
  return Number.isSafeInteger(value) ? value : 0;
}

function textAt(bytes: Uint8Array, path: readonly number[]): string | null {
  const value = messageAt(bytes, path);
  if (value === null) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(value).trim();
  return text.length > 0 ? text : null;
}

function timeOf(metadata: Uint8Array): number | null {
  for (const number of [8, 7, 6, 1]) {
    const time = messageAt(metadata, [number]);
    const seconds = numberAt(time, 1);
    if (seconds > 0) return seconds * 1000 + Math.floor(numberAt(time, 2) / 1_000_000);
  }
  return null;
}

/** The model a conversation ran on, without its reasoning level, which no rate depends on. */
function modelOf(executors: readonly Uint8Array[], generations: readonly Uint8Array[]) {
  const asked = executors.map((data) => textAt(data, [10, 1, 28])).findLast((name) => name);
  if (asked) return asked.replace(LEVEL_SUFFIX, "");
  const served = generations.map((data) => textAt(data, [1, 19])).findLast((name) => name);
  return served ?? ANTIGRAVITY_MODEL_NOT_RECORDED;
}

export interface AntigravityConversation {
  readonly conversationId: string;
  readonly steps: readonly { readonly idx: number; readonly metadata: Uint8Array | null }[];
  readonly executors: readonly Uint8Array[];
  readonly generations: readonly Uint8Array[];
}

/** One record per model call of a conversation. */
export function antigravityRecordsFrom(
  conversation: AntigravityConversation,
  billing: AntigravityBilling,
): UsageRecord[] {
  const model = modelOf(conversation.executors, conversation.generations);
  return conversation.steps.flatMap(({ idx, metadata }) => {
    if (metadata === null) return [];
    const usage = messageAt(metadata, [9]);
    if (usage === null) return [];
    const timestampMs = timeOf(metadata);
    if (timestampMs === null) return [];
    const outputTokens = numberAt(usage, 3);
    const totals: UsageTokenTotals = {
      uncachedInputTokens: numberAt(usage, 2),
      cachedInputTokens: numberAt(usage, 5),
      cacheCreationTokens: 0,
      outputTokens,
      reasoningTokens: Math.min(outputTokens, numberAt(usage, 9)),
    };
    if (totalTokens(totals) === 0) return [];
    return [
      {
        provider: "antigravity",
        speed: "standard",
        timestampMs,
        model,
        // Antigravity calls only its own service, whichever maker's model answers.
        modelProvider: billing,
        modelProviderSource: "harness",
        sessionId: conversation.conversationId,
        totals,
        reportedCostUsd: null,
        dedupeKey: `antigravity:${conversation.conversationId}:${idx}`,
      } satisfies UsageRecord,
    ];
  });
}

const bytesOf = (value: unknown): Uint8Array | null =>
  value instanceof Uint8Array && value.length > 0 ? value : null;

/** The usage of one conversation's database, opened for reading only and closed after. */
export function readAntigravityRecords(
  file: string,
  conversationId: string,
  billing: AntigravityBilling,
): UsageRecord[] | null {
  let store: NodeSqlite.DatabaseSync;
  try {
    store = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const rows = (query: string) => store.prepare(query).all() as Record<string, unknown>[];
    const conversation: AntigravityConversation = {
      conversationId,
      steps: rows("select idx, metadata from steps order by idx").map((row) => ({
        idx: Number(row["idx"]),
        metadata: bytesOf(row["metadata"]),
      })),
      executors: rows("select data from executor_metadata order by idx").flatMap(
        (row) => bytesOf(row["data"]) ?? [],
      ),
      generations: rows("select data from gen_metadata order by idx").flatMap(
        (row) => bytesOf(row["data"]) ?? [],
      ),
    };
    return antigravityRecordsFrom(conversation, billing);
  } catch {
    return null;
  } finally {
    store.close();
  }
}
