import { describe, expect, it } from "@effect/vitest";

import {
  decodeScanCache,
  encodeScanCache,
  makeScanCacheWriter,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

import { TEST_FORMAT_MAP } from "./usageTestFormats.ts";
import { initialCodexScanState, parseCodexLine } from "../provider/Drivers/codexUsage.ts";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: 1_786_000_000_000,
    model: "claude-fable-5",
    modelProvider: "anthropic",
    modelProviderSource: "harness",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: "msg_1:",
    ...overrides,
  };
}

function position(overrides: Partial<CachedFile["position"]> = {}): CachedFile["position"] {
  return {
    resumeOffset: 120,
    guardLength: 64,
    guardHash: 0xdeadbeef,
    state: null,
    ...overrides,
  };
}

function cacheWith(entries: readonly [string, number, readonly UsageRecord[]][]): ScanCache {
  const cache: ScanCache = new Map();
  for (const [path, mtimeMs, records] of entries) {
    cache.set(path, {
      size: records.length * 10,
      mtimeMs,
      provider: "claude",
      records,
      tailRecords: [],
      malformedRecords: 0,
      position: position(),
    });
  }
  return cache;
}

describe("scan cache round trip", () => {
  it("distinguishes upstream and fork v8 rows without losing usage history", () => {
    const usage = record({
      rateModel: "claude-fable-5",
      modelProvider: "anthropic",
      modelProviderSource: "recorded",
    });
    const current = encodeScanCache(cacheWith([["/v8.jsonl", 100, [usage]]]));
    const fork = { ...current, version: 8 };
    const upstream = {
      ...current,
      version: 8,
      files: Object.fromEntries(
        Object.entries(current.files).map(([file, entry]) => [
          file,
          { ...entry, r: entry.r.map((row) => [...row.slice(0, 11), ...row.slice(13)]) },
        ]),
      ),
    };
    expect(decodeScanCache(fork, TEST_FORMAT_MAP).get("/v8.jsonl")?.records[0]).toMatchObject({
      modelProvider: "anthropic",
      modelProviderSource: "recorded",
      totals: usage.totals,
    });
    const decoded = decodeScanCache(upstream, TEST_FORMAT_MAP).get("/v8.jsonl")?.records[0];
    expect(decoded).toMatchObject({ rateModel: usage.rateModel, totals: usage.totals });
    expect(decoded?.modelProvider).toBeUndefined();
  });
  it("distinguishes fork provider-attribution v5 tuples from upstream speed v5 tuples", () => {
    const usage = record({
      model: "glm-5.3",
      modelProvider: "zai-coding-plan",
      modelProviderSource: "recorded",
      speed: "fast",
    });
    const current = encodeScanCache(cacheWith([["/legacy.jsonl", 100, [usage]]]));
    expect(current.version).toBe(9);
    const fork = {
      ...current,
      version: 5,
      files: Object.fromEntries(
        Object.entries(current.files).map(([file, entry]) => [
          file,
          { ...entry, r: entry.r.map((row) => [...row.slice(0, 10), row[11], row[12]]) },
        ]),
      ),
    };
    const upstream = {
      ...current,
      version: 5,
      files: Object.fromEntries(
        Object.entries(current.files).map(([file, entry]) => [
          file,
          { ...entry, r: entry.r.map((row) => row.slice(0, 11)) },
        ]),
      ),
    };
    expect(decodeScanCache(fork, TEST_FORMAT_MAP).get("/legacy.jsonl")?.records[0]).toMatchObject({
      modelProvider: "zai-coding-plan",
      modelProviderSource: "recorded",
      speed: "standard",
      totals: usage.totals,
    });
    const speedRecord = decodeScanCache(upstream, TEST_FORMAT_MAP).get("/legacy.jsonl")?.records[0];
    expect(speedRecord).toMatchObject({ speed: "fast", totals: usage.totals });
    expect(speedRecord?.modelProvider).toBeUndefined();
  });

  it("restores cached history unchanged except for Claude local placeholders", () => {
    const original = cacheWith([
      [
        "/a.jsonl",
        100,
        [record(), record({ dedupeKey: "msg_2:", model: "claude-opus-5-5", speed: "fast" })],
      ],
      [
        "/b.jsonl",
        200,
        [
          record({
            sessionId: "session-b",
            reportedCostUsd: 1.5,
            totals: {
              uncachedInputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
            },
          }),
        ],
      ],
    ]);
    original.set("/grok.jsonl", {
      size: 40,
      malformedRecords: 2,
      mtimeMs: 300,
      provider: "grok",
      records: [
        record({ provider: "grok", model: "grok-4.5-build", dedupeKey: "s:p:grok-4.5-build" }),
        record({ provider: "grok", model: "<synthetic>", dedupeKey: "s:p:<synthetic>" }),
      ],
      tailRecords: [record({ provider: "grok", model: "<synthetic>", dedupeKey: null })],
      position: position({ resumeOffset: 30, guardLength: 30, guardHash: 123 }),
    });
    const state = initialCodexScanState();
    for (const line of [
      { type: "session_meta", payload: { id: "session-c", model_provider: "openai" } },
      { type: "turn_context", payload: { model: "gpt-6-astra", turn_id: "native-turn" } },
      {
        type: "event_msg",
        timestamp: "2026-08-01T10:00:00Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 1, output_tokens: 2 } },
        },
      },
    ])
      parseCodexLine(JSON.stringify(line), state);
    const pending = {
      ...record({
        provider: "codex",
        model: "gpt-6-astra",
        sessionId: "session-c",
        dedupeKey: null,
      }),
      unresolvedServiceTierTurnId: "native-turn",
    };
    const pendingTail = { ...pending, unresolvedServiceTierTurnId: "native-tail" };
    original.set("/codex.jsonl", {
      size: 80,
      malformedRecords: 3,
      mtimeMs: 400,
      provider: "codex",
      records: [
        record({
          provider: "codex",
          model: "gpt-6-astra",
          rateModel: "gpt-6",
          dedupeKey: null,
          speed: "ultrafast",
        }),
        pending,
      ],
      tailRecords: [pendingTail],
      position: position({ state }),
    });

    original.set("/a.jsonl", {
      ...original.get("/a.jsonl")!,
      tailRecords: [record({ dedupeKey: "msg_tail:" })],
    });
    const claude = original.get("/a.jsonl")!;
    const cached = new Map(original);
    cached.set("/a.jsonl", {
      ...claude,
      records: [...claude.records, record({ model: "<synthetic>" })],
      tailRecords: [
        ...claude.tailRecords,
        record({ model: "<synthetic>", dedupeKey: "msg_tail:" }),
      ],
    });
    const restored = decodeScanCache(
      JSON.parse(JSON.stringify(encodeScanCache(cached))),
      TEST_FORMAT_MAP,
    );

    expect(restored.size).toBe(4);
    expect(restored).toEqual(original);
  });

  it.each([5, 6, 7])(
    "retains v%s history and compatible positions but invalidates obsolete state",
    (version) => {
      const original = cacheWith([["/gone.jsonl", 100, [record({ speed: "fast" })]]]);
      original.set("/gone-codex.jsonl", {
        ...original.get("/gone.jsonl")!,
        provider: "codex",
        records: [record({ provider: "codex", speed: "fast", dedupeKey: null })],
        position: position({
          state: {
            ...(version >= 6 ? initialCodexScanState() : {}),
            model: "gpt-6-astra",
            speed: "fast",
            sessionId: "session-a",
            lastUsageSignature: null,
            sawSessionMeta: true,
            suppressingForkCopies: false,
            forkCopyAnchorMs: 0,
          },
        }),
      });
      original.set("/gone-pi.jsonl", {
        ...original.get("/gone.jsonl")!,
        size: 256,
        provider: "pi",
        records: [record({ provider: "pi", model: "anthropic/claude-fable-5" })],
        malformedRecords: 3,
        position: position({ state: { sessionId: "session-a" } }),
      });
      const encoded = encodeScanCache(original);
      const entry = encoded.files["/gone.jsonl"]!;
      const legacy = {
        ...encoded,
        version,
        files: {
          ...encoded.files,
          "/gone.jsonl": {
            s: entry.s,
            m: entry.m,
            p: entry.p,
            r: entry.r,
            t: entry.t,
            o: entry.o,
            gl: entry.gl,
            gh: entry.gh,
            cs: entry.cs,
          },
        },
      };

      // The fork's v5 rows hold the provider fields where upstream's hold the
      // speed, and no rate model. Version 6 rows already have today's layout.
      // Only upstream wrote v7, so its rows go straight from the speed to the rate model.
      const forkV5 = (row: readonly unknown[]) => [...row.slice(0, 10), row[11], row[12]];
      const upstreamV7 = (row: readonly unknown[]) => [...row.slice(0, 11), ...row.slice(13)];
      const toLegacyRow = version === 5 ? forkV5 : version === 7 ? upstreamV7 : undefined;
      const document =
        toLegacyRow === undefined
          ? legacy
          : {
              ...legacy,
              files: Object.fromEntries(
                Object.entries(legacy.files).map(([file, value]) => [
                  file,
                  { ...value, r: value.r.map(toLegacyRow), t: value.t.map(toLegacyRow) },
                ]),
              ),
            };
      const expected = (file: NonNullable<ReturnType<typeof original.get>>) =>
        version === 5
          ? {
              ...file,
              records: file.records.map((record) => ({ ...record, speed: "standard" as const })),
            }
          : version === 7
            ? {
                ...file,
                records: file.records.map(
                  ({ modelProvider: _provider, modelProviderSource: _source, ...record }) => record,
                ),
              }
            : file;

      const restored = decodeScanCache(JSON.parse(JSON.stringify(document)), TEST_FORMAT_MAP);
      expect(restored.get("/gone.jsonl")).toEqual(expected(original.get("/gone.jsonl")!));
      expect(restored.get("/gone-codex.jsonl")).toEqual({
        ...expected(original.get("/gone-codex.jsonl")!),
        size: -1,
        position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
      });
      expect(restored.get("/gone-pi.jsonl")).toEqual(
        version >= 6
          ? expected(original.get("/gone-pi.jsonl")!)
          : {
              ...expected(original.get("/gone-pi.jsonl")!),
              size: -1,
              position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
            },
      );
    },
  );

  it("rewrites only changed entries and still restores the whole cache", () => {
    const write = makeScanCacheWriter();
    const cache = cacheWith([
      ["/a.jsonl", 100, [record()]],
      ["/b.jsonl", 200, [record({ sessionId: "session-b" })]],
    ]);
    cache.set("/b.jsonl", { ...cache.get("/b.jsonl")!, malformedRecords: 2 });
    const sources = { "claude\u0000/projects": { dir: "/projects", volumeId: "1:2" } };
    expect(decodeScanCache(JSON.parse(write(cache, { sources })), TEST_FORMAT_MAP)).toEqual(cache);

    cache.set("/b.jsonl", {
      ...cache.get("/b.jsonl")!,
      size: 30,
      malformedRecords: 4,
      records: [record({ sessionId: "session-c", model: "claude-opus-5-5", dedupeKey: "msg_3:" })],
    });
    const document = JSON.parse(write(cache, { sources }));
    expect(decodeScanCache(document, TEST_FORMAT_MAP)).toEqual(cache);
    expect(document.sources).toEqual(sources);
  });

  it("interns repeated model and session strings", () => {
    const encoded = encodeScanCache(
      cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" }), record()]]]),
    );

    expect(encoded.models).toEqual(["claude-fable-5", "anthropic"]);
    expect(encoded.sessions).toEqual(["session-a"]);
  });

  it("treats a corrupt or foreign document as an empty cache", () => {
    expect(decodeScanCache(null, TEST_FORMAT_MAP).size).toBe(0);
    expect(decodeScanCache("nonsense", TEST_FORMAT_MAP).size).toBe(0);
    expect(
      decodeScanCache({ version: 999, models: [], sessions: [], files: {} }, TEST_FORMAT_MAP).size,
    ).toBe(0);
  });

  it("skips malformed file entries but keeps good ones", () => {
    const encoded = encodeScanCache(cacheWith([["/good.jsonl", 100, [record()]]]));
    const withJunk = {
      ...encoded,
      files: { ...encoded.files, "/bad.jsonl": { s: "nope", m: 1, p: "claude", r: [] } },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(withJunk)), TEST_FORMAT_MAP);
    expect([...restored.keys()]).toEqual(["/good.jsonl"]);
  });

  it("drops the whole entry when any row is corrupt, forcing a cold re-parse", () => {
    const encoded = encodeScanCache(
      cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" })]]]),
    );
    const rows = encoded.files["/a.jsonl"]!.r;
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": {
          ...encoded.files["/a.jsonl"]!,
          r: [rows[0]!, [...rows[1]!.slice(0, 3), "not-a-number", ...rows[1]!.slice(4)]],
        },
      },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(poisoned)), TEST_FORMAT_MAP);
    expect(restored.has("/a.jsonl")).toBe(false);
  });
});
