import type { UsageProviderKind } from "@t3tools/contracts";
import type {
  TranscriptUsageFormat,
  UsageRecord,
  UsageSpeed,
} from "@t3tools/provider-core/server/usage";
import * as Schema from "effect/Schema";

import { GUARD_LENGTH, type TranscriptParsePosition } from "./usageTranscriptReader.ts";

// v2: Codex fork-copy suppression changed what a file parses to, so v1
// entries would keep serving double-counted records forever.
// v3: entries carry the parse position and reducer state so a grown file
// re-parses only its appended bytes instead of starting over.
// v4: records carry Claude fast mode, which v3 rows never captured.
// v5: Codex records carry their service tier. v4 rows store speed the same
// way, so v4 entries still load; see `decodeScanCache` for v4 stateful entries.
// v6 (fork): records also carry the model provider and how it is known. The
// fork's own earlier v5 rows put those two where upstream v5 rows keep the
// speed; such a row is 12 long, an upstream v5 row 11.
const USAGE_SCAN_CACHE_VERSION = 6 as const;
const SPEED_COMPATIBLE_SINCE_VERSION = 4;
/** Serialised as the index into this list. */
const PROVIDER_SOURCE_CODES = [null, "recorded", "harness"] as const;

/**
 * An older server sharing that directory cannot read a newer cache and would
 * replace it, dropping saved usage for deleted transcripts. Separate files keep
 * both.
 */
export const SCAN_CACHE_FILE_NAME = "usage-scan-cache-v6.json";
/** Upstream's v5 file, or the fork's own v5 file before it moved to v6. */
export const PREVIOUS_SCAN_CACHE_FILE_NAME = "usage-scan-cache-v5.json";
export const LEGACY_SCAN_CACHE_FILE_NAME = "usage-scan-cache.json";

const SPEEDS: readonly UsageSpeed[] = ["standard", "fast", "ultrafast"];

export interface CachedFile {
  readonly size: number;
  readonly mtimeMs: number;
  readonly provider: UsageProviderKind;
  readonly records: readonly UsageRecord[];
  /**
   * Records from a trailing segment the writer had not newline-terminated at
   * parse time. Kept apart from `records` because an incremental parse
   * re-reads that segment and would otherwise double count it.
   */
  readonly tailRecords: readonly UsageRecord[];
  readonly position: TranscriptParsePosition;
}

export type ScanCache = Map<string, CachedFile>;

type SerializedRecord = readonly [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  dedupeKey: string | null,
  reportedCostUsd: number | null,
  speed: number,
  /** Interned in the model table; -1 is a recorded absence, -2 no attribution at all. */
  modelProviderIndex: number,
  /** Index into `PROVIDER_SOURCE_CODES`, or -1 when the record has none. */
  modelProviderSource: number,
  /** Optional trailing field keeps existing cache rows readable. */
  rateModelIndex?: number | null,
];

interface SerializedFile {
  readonly s: number;
  readonly m: number;
  readonly p: UsageProviderKind;
  readonly r: readonly SerializedRecord[];
  readonly t: readonly SerializedRecord[];
  readonly o: number;
  readonly gl: number;
  readonly gh: number;
  readonly cs: unknown;
}

interface SerializedCache {
  readonly version: number;
  readonly models: readonly string[];
  readonly sessions: readonly string[];
  readonly files: Readonly<Record<string, SerializedFile>>;
}

interface InternTables {
  readonly models: string[];
  readonly sessions: string[];
  readonly modelIndex: Map<string, number>;
  readonly sessionIndex: Map<string, number>;
}

function makeInternTables(): InternTables {
  return { models: [], sessions: [], modelIndex: new Map(), sessionIndex: new Map() };
}

function intern(table: string[], index: Map<string, number>, value: string): number {
  const existing = index.get(value);
  if (existing !== undefined) return existing;
  const next = table.length;
  table.push(value);
  index.set(value, next);
  return next;
}

function serializeFile(entry: CachedFile, tables: InternTables): SerializedFile {
  const serializeRecord = (record: UsageRecord): SerializedRecord => [
    record.timestampMs,
    intern(tables.models, tables.modelIndex, record.model),
    intern(tables.sessions, tables.sessionIndex, record.sessionId),
    record.totals.uncachedInputTokens,
    record.totals.cachedInputTokens,
    record.totals.cacheCreationTokens,
    record.totals.outputTokens,
    record.totals.reasoningTokens,
    record.dedupeKey,
    record.reportedCostUsd,
    SPEEDS.indexOf(record.speed),
    record.modelProvider === undefined
      ? -2
      : record.modelProvider === null
        ? -1
        : intern(tables.models, tables.modelIndex, record.modelProvider),
    record.modelProviderSource === undefined
      ? -1
      : PROVIDER_SOURCE_CODES.indexOf(record.modelProviderSource),
    record.rateModel === undefined
      ? null
      : intern(tables.models, tables.modelIndex, record.rateModel),
  ];
  return {
    s: entry.size,
    m: entry.mtimeMs,
    p: entry.provider,
    r: entry.records.map(serializeRecord),
    t: entry.tailRecords.map(serializeRecord),
    o: entry.position.resumeOffset,
    gl: entry.position.guardLength,
    gh: entry.position.guardHash,
    cs: entry.position.state,
  };
}

export function encodeScanCache(cache: ScanCache): SerializedCache {
  const tables = makeInternTables();
  const files: Record<string, SerializedFile> = {};
  for (const [path, entry] of cache) files[path] = serializeFile(entry, tables);
  return {
    version: USAGE_SCAN_CACHE_VERSION,
    models: tables.models,
    sessions: tables.sessions,
    files,
  };
}

/**
 * Entries are replaced, never mutated, when their file changes, so an entry's JSON is memoised by
 * identity. The intern tables only grow, so a memoised entry's indexes stay valid; a pruned entry
 * can leave an unused string behind until the next process start.
 */
export function makeScanCacheWriter(): (
  cache: ScanCache,
  extra: Readonly<Record<string, unknown>>,
) => string {
  const tables = makeInternTables();
  const fragments = new WeakMap<CachedFile, string>();
  return (cache, extra) => {
    const files: string[] = [];
    for (const [path, entry] of cache) {
      let fragment = fragments.get(entry);
      if (fragment === undefined) {
        fragment = JSON.stringify(serializeFile(entry, tables));
        fragments.set(entry, fragment);
      }
      files.push(`${JSON.stringify(path)}:${fragment}`);
    }
    // Encoded after the files, which may have added to the intern tables.
    const head = JSON.stringify({
      ...extra,
      version: USAGE_SCAN_CACHE_VERSION,
      models: tables.models,
      sessions: tables.sessions,
    });
    return `${head.slice(0, -1)},"files":{${files.join(",")}}}`;
  };
}

function isRecordArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function decodeScanCache(
  document: unknown,
  formats: ReadonlyMap<UsageProviderKind, TranscriptUsageFormat<unknown>>,
): ScanCache {
  const cache: ScanCache = new Map();
  const isValidState = makeStateValidators(formats);
  if (typeof document !== "object" || document === null) return cache;

  const root = document as Partial<SerializedCache>;
  const version = root.version;
  if (
    typeof version !== "number" ||
    version < SPEED_COMPATIBLE_SINCE_VERSION ||
    version > USAGE_SCAN_CACHE_VERSION
  ) {
    return cache;
  }
  if (!isRecordArray(root.models) || !isRecordArray(root.sessions)) return cache;
  if (typeof root.files !== "object" || root.files === null) return cache;

  if (!root.models.every((value) => typeof value === "string")) return cache;
  if (!root.sessions.every((value) => typeof value === "string")) return cache;
  const models = root.models as readonly string[];
  const sessions = root.sessions as readonly string[];

  // Any corrupt row disqualifies the whole entry. Keeping the survivors
  // under the original (size, mtime) would read as a valid warm hit and the
  // file would never be re-parsed, silently losing the dropped rows' usage.
  const decodeRecords = (
    rows: readonly unknown[],
    provider: UsageProviderKind,
  ): UsageRecord[] | null => {
    const records: UsageRecord[] = [];
    for (const row of rows) {
      if (!isRecordArray(row) || row.length < (version >= 6 ? 13 : 11)) return null;
      const [
        timestampMs,
        modelIndex,
        sessionIndex,
        uncached,
        cached,
        cacheCreation,
        output,
        reasoning,
        dedupeKey,
        reportedCostUsd,
        speedIndex,
      ] = row as SerializedRecord;
      // The fork's own v5 rows hold the model provider where upstream keeps the speed.
      const forkLegacy = version < 6 && row.length === 12;
      const speed = forkLegacy
        ? "standard"
        : typeof speedIndex === "number"
          ? SPEEDS[speedIndex]
          : undefined;
      const modelProviderIndex = version >= 6 ? row[11] : forkLegacy ? row[10] : -2;
      const sourceIndex = version >= 6 ? row[12] : forkLegacy ? row[11] : -1;
      // Upstream's rate model trails the fork's provider fields; rows written before it have none.
      const rateModelIndex = version >= 6 ? row[13] : undefined;
      const modelProvider =
        modelProviderIndex === -2
          ? undefined
          : modelProviderIndex === -1
            ? null
            : typeof modelProviderIndex === "number"
              ? models[modelProviderIndex]
              : undefined;
      const modelProviderSource =
        sourceIndex === -1
          ? undefined
          : typeof sourceIndex === "number"
            ? PROVIDER_SOURCE_CODES[sourceIndex]
            : undefined;
      if (
        (modelProviderIndex !== -2 && modelProvider === undefined) ||
        (sourceIndex !== -1 && modelProviderSource === undefined)
      ) {
        return null;
      }

      const model = typeof modelIndex === "number" ? models[modelIndex] : undefined;
      const rateModel = typeof rateModelIndex === "number" ? models[rateModelIndex] : undefined;
      if (
        typeof timestampMs !== "number" ||
        !Number.isFinite(timestampMs) ||
        model === undefined ||
        (rateModelIndex != null && rateModel === undefined) ||
        !Number.isFinite(uncached) ||
        !Number.isFinite(cached) ||
        !Number.isFinite(cacheCreation) ||
        !Number.isFinite(output) ||
        !Number.isFinite(reasoning) ||
        speed === undefined
      ) {
        return null;
      }

      records.push({
        provider,
        timestampMs,
        model,
        ...(modelProvider === undefined ? {} : { modelProvider }),
        ...(modelProviderSource === undefined ? {} : { modelProviderSource }),
        ...(rateModel === undefined ? {} : { rateModel }),
        sessionId: (typeof sessionIndex === "number" ? sessions[sessionIndex] : undefined) ?? "",
        totals: {
          uncachedInputTokens: uncached,
          cachedInputTokens: cached,
          cacheCreationTokens: cacheCreation,
          outputTokens: output,
          reasoningTokens: reasoning,
        },
        reportedCostUsd: typeof reportedCostUsd === "number" ? reportedCostUsd : null,
        speed,
        dedupeKey: typeof dedupeKey === "string" ? dedupeKey : null,
      });
    }
    return records;
  };

  for (const [path, raw] of Object.entries(root.files)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Partial<SerializedFile>;
    if (typeof entry.s !== "number" || typeof entry.m !== "number") continue;
    if (entry.p === undefined) continue;
    const format = formats.get(entry.p);
    if (format === undefined) continue;
    if (!isRecordArray(entry.r) || !isRecordArray(entry.t)) continue;
    // Position fields feed byte offsets and a Buffer allocation in the reader,
    // so anything outside their real ranges must reject the entry: a bogus
    // guard length would otherwise fail every parse of the file, silently
    // dropping its usage instead of costing the documented cold re-parse.
    if (
      typeof entry.o !== "number" ||
      !Number.isSafeInteger(entry.o) ||
      entry.o < 0 ||
      typeof entry.gl !== "number" ||
      !Number.isSafeInteger(entry.gl) ||
      entry.gl < 0 ||
      entry.gl > GUARD_LENGTH ||
      entry.gl > entry.o ||
      typeof entry.gh !== "number" ||
      !Number.isFinite(entry.gh)
    ) {
      continue;
    }
    // v4 records of stateful formats (Codex) predate service tiers, so they
    // all priced as standard. Keep them, because the rollout may be gone, but
    // make a live rollout re-parse whole: no file has size -1, and a zero
    // position cannot resume.
    const legacy = format.state !== undefined && version < USAGE_SCAN_CACHE_VERSION;
    // A corrupt state disqualifies the entry: resuming with it would attach
    // appended usage to the wrong model or replay fork-copied history.
    if (!legacy && !isValidState.get(entry.p)?.(entry.cs)) continue;

    const provider = entry.p;
    const records = decodeRecords(entry.r, provider);
    const tailRecords = decodeRecords(entry.t, provider);
    if (records === null || tailRecords === null) continue;

    cache.set(path, {
      size: legacy ? -1 : entry.s,
      mtimeMs: entry.m,
      provider,
      records,
      tailRecords,
      position: legacy
        ? { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null }
        : {
            resumeOffset: entry.o,
            guardLength: entry.gl,
            guardHash: entry.gh,
            state: entry.cs,
          },
    });
  }

  return cache;
}

function makeStateValidators(
  formats: ReadonlyMap<UsageProviderKind, TranscriptUsageFormat<unknown>>,
): ReadonlyMap<UsageProviderKind, (value: unknown) => boolean> {
  return new Map(
    [...formats].map(([provider, format]) => {
      const isState = format.state === undefined ? undefined : Schema.is(format.state.schema);
      return [
        provider,
        (value: unknown) => value === null || (isState !== undefined && isState(value)),
      ] as const;
    }),
  );
}

export function pruneScanCache(cache: ScanCache, retentionCutoffMs: number): number {
  let removed = 0;
  for (const [path, entry] of cache) {
    if (entry.mtimeMs < retentionCutoffMs) {
      cache.delete(path);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Callers stitching an incremental parse together pass one `seen` set across the line and tail
 * record batches so the whole file stays deduplicated as a unit; the set is mutated in place.
 */
export function dedupeWithinFile(
  records: readonly UsageRecord[],
  seen: Set<string> = new Set(),
): readonly UsageRecord[] {
  const kept: UsageRecord[] = [];
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    kept.push(record);
  }
  return kept;
}
