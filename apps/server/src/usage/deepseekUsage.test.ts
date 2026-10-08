// @effect-diagnostics nodeBuiltinImport:off - the store of the DeepSeek harness is read from real
// files, as the reader itself reads them.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { listTranscriptFiles, readTranscriptRecords } from "./usageTranscriptReader.ts";
import { DEEPSEEK_MODEL_NOT_RECORDED, parseDeepSeekSession } from "./usageTranscripts.ts";

// The shape of a session in the store of the DeepSeek harness, with made-up numbers.
const session = (totals: Record<string, number> | null) =>
  JSON.stringify(
    {
      version: 7,
      record: {
        identity: { formatVersion: 3, createdAt: 1_790_000_000_000, cwd: "/work" },
        rows: {
          title: { ver: 1, seq: 3, val: "a session" },
          ...(totals
            ? { tokenUsage: { ver: 2, seq: 9, val: { totals, last: { turn: 2, step: 1 } } } }
            : {}),
        },
      },
    },
    null,
    2,
  );

describe("parseDeepSeekSession", () => {
  it("takes the totals the harness reports, and names no model and no price", () => {
    const record = parseDeepSeekSession(
      session({
        uncachedInputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 900,
        cacheWriteTokens: 5,
      }),
      "abc",
      1_790_000_500_000,
    );
    expect(record).toEqual({
      provider: "deepseek",
      speed: "standard",
      timestampMs: 1_790_000_500_000,
      model: DEEPSEEK_MODEL_NOT_RECORDED,
      modelProvider: null,
      modelProviderSource: null,
      sessionId: "abc",
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 900,
        cacheCreationTokens: 5,
        outputTokens: 20,
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
      dedupeKey: "deepseek:abc",
    });
  });

  it("makes nothing up for a session with no usage, or one that cannot be read", () => {
    expect(parseDeepSeekSession(session(null), "a", 1)).toBeNull();
    expect(
      parseDeepSeekSession(
        session({
          uncachedInputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
        "a",
        1,
      ),
    ).toBeNull();
    expect(parseDeepSeekSession("{ cut off", "a", 1)).toBeNull();
  });
});

describe("a DeepSeek store on disk", () => {
  it("is listed by its .json files and each is read whole, again when it is written again", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deepseek-usage-"));
    try {
      const file = NodePath.join(root, "s1.json");
      await NodeFSP.writeFile(
        file,
        session({
          uncachedInputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
        }),
      );
      await NodeFSP.writeFile(NodePath.join(root, "other.jsonl"), "{}\n");
      const files = await listTranscriptFiles(root, 0, { extension: ".json" });
      expect(files.map((entry) => NodePath.basename(entry.path))).toEqual(["s1.json"]);

      const first = await readTranscriptRecords(file, "deepseek");
      expect(first?.records.map((record) => record.totals.outputTokens)).toEqual([2]);
      // The harness writes the whole document again with the new totals. It is not added twice.
      await NodeFSP.writeFile(
        file,
        session({
          uncachedInputTokens: 1,
          outputTokens: 7,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
        }),
      );
      const again = await readTranscriptRecords(file, "deepseek", first?.position);
      expect(again?.resumed).toBe(false);
      expect(again?.records.map((record) => record.totals.outputTokens)).toEqual([7]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
