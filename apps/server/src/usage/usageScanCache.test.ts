import { describe, expect, it } from "@effect/vitest";

import {
  decodeScanCache,
  makeScanCacheWriter,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

import { TEST_FORMAT_MAP } from "./usageTestFormats.ts";
import { initialCodexScanState, parseCodexLine } from "../provider/Drivers/codexUsage.ts";

const parse = (parts: Iterable<string>) => JSON.parse([...parts].join(""));

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
      malformedRecords: [],
      position: position(),
    });
  }
  return cache;
}

function writtenCache(cache: ScanCache): {
  version: number;
  models: string[];
  sessions: string[];
  files: Record<
    string,
    {
      s: number;
      m: number;
      p: UsageRecord["provider"];
      r: unknown[][];
      t: unknown[][];
      mr: number;
      o: number;
      gl: number;
      gh: number;
      cs: unknown;
    }
  >;
} {
  return parse(makeScanCacheWriter()(cache, {}));
}

/** Upstream rows go from the speed straight to the rate model. */
const upstreamRow = (row: readonly unknown[]) => [...row.slice(0, 11), ...row.slice(13)];

function asUpstream(document: ReturnType<typeof writtenCache>, version: number) {
  return {
    ...document,
    version,
    files: Object.fromEntries(
      Object.entries(document.files).map(([file, entry]) => [
        file,
        { ...entry, r: entry.r.map(upstreamRow), t: entry.t.map(upstreamRow) },
      ]),
    ),
  };
}

const unattributedRecord = ({
  modelProvider: _provider,
  modelProviderSource: _source,
  ...rest
}: UsageRecord): UsageRecord => rest;

function unattributed(file: CachedFile): CachedFile {
  return {
    ...file,
    records: file.records.map(unattributedRecord),
    tailRecords: file.tailRecords.map(unattributedRecord),
  };
}

describe("scan cache round trip", () => {
  it("distinguishes upstream and fork v8 rows without losing usage history", () => {
    const usage = record({
      rateModel: "claude-fable-5",
      modelProvider: "anthropic",
      modelProviderSource: "recorded",
    });
    const current = writtenCache(cacheWith([["/v8.jsonl", 100, [usage]]]));
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
  // Codex entries before v14 re-parse; the fork's v12 and upstream's v12 share a version number.
  it.each([
    { layout: "upstream", version: 9, malformedRecords: [], reparse: true, resumes: false },
    { layout: "fork", version: 9, malformedRecords: [1, 2], reparse: true, resumes: false },
    { layout: "fork", version: 10, malformedRecords: [], reparse: true, resumes: false },
    { layout: "upstream", version: 11, malformedRecords: [1, 2], reparse: true, resumes: false },
    { layout: "fork", version: 12, malformedRecords: [], reparse: true, resumes: false },
    { layout: "upstream", version: 12, malformedRecords: [], reparse: true, resumes: false },
    { layout: "upstream", version: 14, malformedRecords: [], reparse: false, resumes: false },
    { layout: "upstream", version: 14, malformedRecords: [1, 2], reparse: true, resumes: false },
    { layout: "upstream", version: 17, malformedRecords: [1, 2], reparse: false, resumes: true },
    { layout: "fork", version: 18, malformedRecords: [1, 2], reparse: false, resumes: true },
    { layout: "fork", version: 19, malformedRecords: [1, 2], reparse: false, resumes: true },
  ])(
    "preserves $layout v$version history with $malformedRecords malformed records (reparse: $reparse)",
    ({ layout, version, malformedRecords, reparse, resumes }) => {
      const usage = record({
        provider: "codex",
        model: "gpt-6-astra",
        rateModel: "gpt-6",
        modelProvider: "openai",
        modelProviderSource: "recorded",
        speed: "ultrafast",
        unresolvedServiceTierTurnId: "native-turn",
      });
      const { unresolvedServiceTierTurnId: _turn, ...settled } = usage;
      const tail = { ...usage, dedupeKey: null, unresolvedServiceTierTurnId: "native-tail" };
      const entry: CachedFile = {
        size: 256,
        mtimeMs: 100,
        provider: "codex",
        records: [settled, usage],
        tailRecords: [tail],
        malformedRecords,
        position: position({ state: initialCodexScanState() }),
      };
      const current = writtenCache(new Map([["/codex.jsonl", entry]]));
      expect(current.version).toBe(19);
      const toLegacyRow = (row: unknown[]) => (layout === "upstream" ? upstreamRow(row) : row);
      const document = {
        ...current,
        version,
        files: Object.fromEntries(
          Object.entries(current.files).map(([path, file]) => [
            path,
            { ...file, r: file.r.map(toLegacyRow), t: file.t.map(toLegacyRow) },
          ]),
        ),
      };
      const expectedRecord = (value: UsageRecord) => {
        const { modelProvider: _provider, modelProviderSource: _source, ...unattributed } = value;
        return layout === "upstream" ? unattributed : value;
      };
      expect(decodeScanCache(document, TEST_FORMAT_MAP).get("/codex.jsonl")).toEqual({
        ...entry,
        records: [expectedRecord(settled), expectedRecord(usage)],
        tailRecords: [expectedRecord(tail)],
        size: reparse ? -1 : entry.size,
        position: resumes
          ? entry.position
          : { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
      });
    },
  );

  it("distinguishes fork provider-attribution v5 tuples from upstream speed v5 tuples", () => {
    const usage = record({
      model: "glm-5.3",
      modelProvider: "zai-coding-plan",
      modelProviderSource: "recorded",
      speed: "fast",
    });
    const current = writtenCache(cacheWith([["/legacy.jsonl", 100, [usage]]]));
    expect(current.version).toBe(19);
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
        [
          record(),
          record({
            dedupeKey: "msg_2:",
            model: "claude-opus-5-5",
            speed: "fast",
            cacheCreation1hTokens: 8,
          }),
        ],
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
      malformedRecords: [1, 2],
      mtimeMs: 300,
      provider: "grok",
      records: [
        record({
          provider: "grok",
          model: "grok-4.5-build",
          modelCalls: 8,
          dedupeKey: "s:p:grok-4.5-build",
        }),
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
      malformedRecords: [1, 2, 3],
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
    const restored = decodeScanCache(parse(makeScanCacheWriter()(cached, {})), TEST_FORMAT_MAP);

    expect(restored.size).toBe(4);
    expect(restored).toEqual(original);
    const encoded = parse(makeScanCacheWriter()(original, {}));
    const { mt: _dates, ...undated } = encoded.files["/codex.jsonl"]!;
    const reparsed = decodeScanCache(
      { ...encoded, files: { ...encoded.files, "/codex.jsonl": undated } },
      TEST_FORMAT_MAP,
    ).get("/codex.jsonl")!;
    expect(reparsed.size).toBe(-1);
    expect(reparsed.position.resumeOffset).toBe(0);
    expect(reparsed.records).toEqual(original.get("/codex.jsonl")!.records);
    expect(reparsed.malformedRecords).toEqual([]);
  });

  it.each([5, 6, 7, 8, 10, 11, 12, 13])(
    "retains v%s history and compatible positions but invalidates obsolete state",
    (version) => {
      const original = cacheWith([["/gone.jsonl", 100, [record({ speed: "fast" })]]]);
      original.set("/gone-codex.jsonl", {
        ...original.get("/gone.jsonl")!,
        provider: "codex",
        malformedRecords: [1],
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
        malformedRecords: [1, 2, 3],
        position: position({ state: { sessionId: "session-a" } }),
      });
      const cleanCodex = {
        ...original.get("/gone-codex.jsonl")!,
        malformedRecords: [],
      };
      original.set("/clean-codex.jsonl", cleanCodex);
      const encoded = writtenCache(original);
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
      // speed, and no rate model. Version 6, 8 and 12 rows here have the fork's layout.
      // Upstream wrote v7, v10, v11 and v13; their rows go from the speed to the rate model.
      const forkV5 = (row: readonly unknown[]) => [...row.slice(0, 10), row[11], row[12]];
      const upstreamVersion = [7, 10, 11, 13].includes(version);
      const toLegacyRow = version === 5 ? forkV5 : upstreamVersion ? upstreamRow : undefined;
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
          : upstreamVersion
            ? unattributed(file)
            : file;

      const restored = decodeScanCache(JSON.parse(JSON.stringify(document)), TEST_FORMAT_MAP);
      expect(restored.get("/gone.jsonl")).toEqual(
        version >= 13
          ? expected(original.get("/gone.jsonl")!)
          : {
              ...expected(original.get("/gone.jsonl")!),
              size: -1,
              position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
            },
      );
      expect(restored.get("/gone-codex.jsonl")).toEqual({
        ...expected(original.get("/gone-codex.jsonl")!),
        size: -1,
        position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
      });
      expect(restored.get("/clean-codex.jsonl")).toEqual({
        ...expected(cleanCodex),
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

  it("re-parses a v14 Codex entry that skipped records and restarts a clean one when it grows", () => {
    const codex = (malformedRecords: readonly number[]): CachedFile => ({
      size: 10,
      mtimeMs: 100,
      provider: "codex",
      records: [record({ provider: "codex", model: "gpt-6-astra", dedupeKey: null })],
      tailRecords: [],
      malformedRecords,
      position: position({
        state: { ...initialCodexScanState(), model: "gpt-6-astra", sessionId: "session-a" },
      }),
    });
    const original: ScanCache = new Map([
      ["/skipped-codex.jsonl", codex([1])],
      ["/clean-codex.jsonl", codex([])],
    ]);
    const v14 = asUpstream(writtenCache(original), 14);

    const restored = decodeScanCache(JSON.parse(JSON.stringify(v14)), TEST_FORMAT_MAP);
    expect(restored.get("/skipped-codex.jsonl")).toEqual({
      ...unattributed(codex([1])),
      size: -1,
      position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
    });
    // Served while unchanged, but its state predates the latest snapshot time, so it cannot resume.
    expect(restored.get("/clean-codex.jsonl")).toEqual({
      ...unattributed(codex([])),
      position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
    });
    // The migrated entries persist without a state and load again under the current version.
    expect(decodeScanCache(parse(makeScanCacheWriter()(restored, {})), TEST_FORMAT_MAP)).toEqual(
      restored,
    );
  });

  it("restarts a grown v15 Codex entry, whose baseline time can be older than its totals", () => {
    const request = {
      input_tokens: 100,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 20,
      reasoning_output_tokens: 0,
      total_tokens: 120,
    };
    const entry: CachedFile = {
      size: 10,
      mtimeMs: 100,
      provider: "codex",
      records: [record({ provider: "codex", model: "gpt-6-astra", dedupeKey: null })],
      tailRecords: [],
      malformedRecords: [],
      position: position({
        state: {
          ...initialCodexScanState(),
          model: "gpt-6-astra",
          lastCumulativeUsage: request,
          latestCumulativeAtMs: 1_786_000_000_000,
        },
      }),
    };
    const current = writtenCache(new Map([["/codex.jsonl", entry]]));

    expect(decodeScanCache(asUpstream(current, 15), TEST_FORMAT_MAP).get("/codex.jsonl")).toEqual({
      ...unattributed(entry),
      position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
    });
    expect(decodeScanCache(current, TEST_FORMAT_MAP).get("/codex.jsonl")).toEqual(entry);
  });

  // The fork wrote its own v10 and v12 in the layout written today; upstream's v12 has no provider fields.
  it.each([
    { layout: "fork", version: 10 },
    { layout: "fork", version: 12 },
    { layout: "upstream", version: 12 },
  ])(
    "re-parses a Claude transcript cached in $layout v$version before 1-hour cache writes were counted",
    ({ layout, version }) => {
      const original = cacheWith([["/claude.jsonl", 100, [record()]]]);
      const current = writtenCache(original);
      const legacy = layout === "upstream" ? asUpstream(current, version) : { ...current, version };

      const restored = decodeScanCache(JSON.parse(JSON.stringify(legacy)), TEST_FORMAT_MAP);
      const file = original.get("/claude.jsonl")!;
      expect(restored.get("/claude.jsonl")).toEqual({
        ...(layout === "upstream" ? unattributed(file) : file),
        size: -1,
        position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
      });
    },
  );

  it.each(["s:p:grok-4.5", "s:p:1786000000000:grok-4.5"])(
    "re-parses v16 Grok transcripts with key %s",
    (dedupeKey) => {
      const original = cacheWith([
        ["/grok/updates.jsonl", 100, [record({ provider: "grok", model: "grok-4.5", dedupeKey })]],
      ]);
      original.set("/grok/updates.jsonl", {
        ...original.get("/grok/updates.jsonl")!,
        provider: "grok",
      });
      const restored = decodeScanCache(asUpstream(writtenCache(original), 16), TEST_FORMAT_MAP);
      expect(restored.get("/grok/updates.jsonl")).toEqual({
        ...original.get("/grok/updates.jsonl"),
        size: -1,
        position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
        records: [
          unattributedRecord(
            record({
              provider: "grok",
              model: "grok-4.5",
              dedupeKey: "s:p:1786000000000:grok-4.5",
            }),
          ),
        ],
      });
    },
  );

  it("rewrites only changed entries and still restores the whole cache", () => {
    const write = makeScanCacheWriter();
    const cache = cacheWith([
      ["/a.jsonl", 100, [record()]],
      ["/b.jsonl", 200, [record({ sessionId: "session-b" })]],
    ]);
    cache.set("/b.jsonl", { ...cache.get("/b.jsonl")!, malformedRecords: [1, 2] });
    const sources = { "claude\u0000/projects": { dir: "/projects", volumeId: "1:2" } };
    expect(decodeScanCache(parse(write(cache, { sources })), TEST_FORMAT_MAP)).toEqual(cache);

    cache.set("/b.jsonl", {
      ...cache.get("/b.jsonl")!,
      size: 30,
      malformedRecords: [1, 2, 3, 4],
      records: [record({ sessionId: "session-c", model: "claude-opus-5-5", dedupeKey: "msg_3:" })],
    });
    const document = parse(write(cache, { sources }));
    expect(decodeScanCache(document, TEST_FORMAT_MAP)).toEqual(cache);
    expect(document.sources).toEqual(sources);
  });

  it("interns repeated model and session strings", () => {
    const encoded = writtenCache(
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
    const encoded = parse(makeScanCacheWriter()(cacheWith([["/good.jsonl", 100, [record()]]]), {}));
    const withJunk = {
      ...encoded,
      files: { ...encoded.files, "/bad.jsonl": { s: "nope", m: 1, p: "claude", r: [] } },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(withJunk)), TEST_FORMAT_MAP);
    expect([...restored.keys()]).toEqual(["/good.jsonl"]);
  });

  it("drops the whole entry when any row is corrupt, forcing a cold re-parse", () => {
    const encoded = parse(
      makeScanCacheWriter()(
        cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" })]]]),
        {},
      ),
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
