import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  DEEPSEEK_MODEL_NOT_RECORDED,
  deepseekUsageReader,
  parseDeepSeekSession,
} from "./deepseekUsage.ts";

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
  const totals = (outputTokens: number) =>
    session({ uncachedInputTokens: 1, outputTokens, cacheReadTokens: 3, cacheWriteTokens: 0 });

  it.effect("reads each session's .json whole, again when it is written again", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "deepseek-usage-" });
      const sessions = path.join(home, "storages", "session_projcache", "sessions");
      yield* fileSystem.makeDirectory(sessions, { recursive: true });
      const file = path.join(sessions, "s1.json");
      yield* fileSystem.writeFileString(file, totals(2));
      yield* fileSystem.writeFileString(path.join(sessions, "other.jsonl"), "{}\n");

      const read = () =>
        deepseekUsageReader.kind === "scan"
          ? deepseekUsageReader.scan({
              instances: [
                {
                  instanceId: ProviderInstanceId.make("deepseek"),
                  config: undefined,
                  environment: { DSH_HOME: home },
                  configured: false,
                },
              ],
              settings: DEFAULT_SERVER_SETTINGS,
              windowStartMs: 0,
              retentionCutoffMs: 0,
              awaitRefresh: false,
            })
          : Effect.die("not a scan reader");
      const outputs = (scans: Effect.Success<ReturnType<typeof read>>) =>
        scans
          .flatMap((scan) => scan.files ?? [])
          .flatMap((entry) => entry.records.map((record) => record.totals.outputTokens));

      expect(outputs(yield* read())).toEqual([2]);
      // The harness writes the whole document again with the new totals. It is not added twice.
      yield* fileSystem.writeFileString(file, totals(7) + " ");
      expect(outputs(yield* read())).toEqual([7]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
