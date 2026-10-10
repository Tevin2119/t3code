import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderUsageReader, UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/http";

import { UsageAggregator } from "../../usage/usageAggregation.ts";
import { hermesRecordFrom } from "./hermesUsage.ts";
import { kimiSessionId, kimiUsageReader, parseKimiLine } from "./kimiUsage.ts";
import { parsePiLine, piSessionId, piUsageReader } from "./piUsage.ts";
import { attributedClaudeUsageFormat, attributedCodexUsageFormat } from "./usageModelProviders.ts";

/** Shaped after a real pi assistant entry. */
const PI_LINE = JSON.stringify({
  type: "message",
  id: "663459a3",
  timestamp: "2026-09-28T12:28:49.347Z",
  message: {
    role: "assistant",
    provider: "openai-codex",
    model: "gpt-6-luna",
    usage: {
      input: 1765,
      output: 55,
      cacheRead: 200,
      cacheWrite: 0,
      reasoning: 20,
      totalTokens: 2020,
      cost: { total: 0.000204 },
    },
  },
});

/** Shaped after a real Kimi Code `usage.record` event. */
const KIMI_LINE = JSON.stringify({
  type: "usage.record",
  agentId: "main",
  model: "kimi-code/k3",
  usage: { inputOther: 17416, output: 314, inputCacheRead: 11520, inputCacheCreation: 0 },
  usageScope: "turn",
  time: 1790719007417,
});

describe("pi", () => {
  it("keeps the provider and model pi recorded, and its own cost", () => {
    const record = parsePiLine(PI_LINE, "01a0e7fd");
    expect(record).toMatchObject({
      provider: "pi",
      speed: "standard",
      model: "gpt-6-luna",
      modelProvider: "openai-codex",
      modelProviderSource: "recorded",
      sessionId: "01a0e7fd",
      reportedCostUsd: 0.000204,
      dedupeKey: "pi:01a0e7fd:663459a3",
      totals: {
        uncachedInputTokens: 1765,
        cachedInputTokens: 200,
        cacheCreationTokens: 0,
        outputTokens: 55,
        reasoningTokens: 20,
      },
    });
  });

  it("reads nothing from a line that is not an assistant's", () => {
    expect(parsePiLine(JSON.stringify({ type: "model_change", model: "x" }), "s")).toBeNull();
  });

  it("takes the session from the name of its file", () => {
    expect(piSessionId("/p/2026-09-28T12-28-44-844Z_01a0e7fd-2fab.jsonl")).toBe("01a0e7fd-2fab");
    expect(kimiSessionId("/k/sessions/wd_x/session_75398f63/agents/main/wire.jsonl")).toBe(
      "session_75398f63",
    );
    expect(kimiSessionId("C:\\k\\sessions\\wd_x\\session_1\\agents\\agent-0\\wire.jsonl")).toBe(
      "session_1",
    );
  });
});

describe("Kimi Code", () => {
  it("splits the provider key from the model Kimi names", () => {
    expect(parseKimiLine(KIMI_LINE, "sess-1")).toMatchObject({
      provider: "kimi",
      model: "k3",
      modelProvider: "kimi-code",
      modelProviderSource: "recorded",
      reportedCostUsd: null,
      totals: { uncachedInputTokens: 17416, cachedInputTokens: 11520, outputTokens: 314 },
    });
  });

  it("keeps a model without a provider key as written, with no provider", () => {
    const line = KIMI_LINE.replace("kimi-code/k3", "__kimi_env_model__");
    expect(parseKimiLine(line, "s")).toMatchObject({
      model: "__kimi_env_model__",
      modelProvider: null,
      modelProviderSource: null,
    });
  });
});

describe("Hermes", () => {
  const row = {
    session_id: "6079eecf",
    model: "glm-5.3",
    billing_provider: "zai",
    task: "",
    input_tokens: 5043,
    output_tokens: 211,
    cache_read_tokens: 8640,
    cache_write_tokens: 0,
    reasoning_tokens: 189,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_source: "none",
    last_seen: 1790710846.55734,
  };

  it("keeps the billing provider and no cost that Hermes does not know", () => {
    expect(hermesRecordFrom(row)).toMatchObject({
      provider: "hermes",
      model: "glm-5.3",
      modelProvider: "zai",
      timestampMs: 1790710846557,
      reportedCostUsd: null,
      totals: {
        uncachedInputTokens: 5043,
        cachedInputTokens: 8640,
        outputTokens: 211,
        reasoningTokens: 189,
      },
    });
  });

  it("keeps a cost Hermes has", () => {
    expect(
      hermesRecordFrom({ ...row, cost_source: "provider", actual_cost_usd: 0.02 })?.reportedCostUsd,
    ).toBe(0.02);
  });
});

describe("attribution", () => {
  const base: UsageRecord = {
    provider: "pi",
    speed: "standard",
    timestampMs: Date.parse("2026-09-28T12:00:00Z"),
    model: "glm-5.3",
    modelProvider: "zai",
    modelProviderSource: "recorded",
    sessionId: "s",
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    dedupeKey: null,
  };

  it("keeps one model apart by harness and by provider", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-09-28",
      untilDay: "2026-09-28",
      rates: new Map(),
    });
    aggregator.add(base);
    aggregator.add({ ...base, provider: "opencode", modelProvider: "zai-coding-plan" });
    aggregator.add({ ...base, provider: "hermes" });
    aggregator.add({ ...base, provider: "hermes" });
    aggregator.add({
      ...base,
      provider: "deepseek",
      modelProvider: null,
      modelProviderSource: null,
    });
    const buckets = aggregator.finish().buckets;
    expect(
      buckets.map((bucket) => [bucket.provider, bucket.modelProvider ?? null, bucket.records]),
    ).toEqual([
      ["deepseek", null, 1],
      ["hermes", "zai", 2],
      ["opencode", "zai-coding-plan", 1],
      ["pi", "zai", 1],
    ]);
    expect(buckets[0]).not.toHaveProperty("modelProviderSource");
  });
});

/** Runs a scan reader over one instance whose environment is `environment`. */
const scanWith = <R>(
  reader: ProviderUsageReader<unknown, R>,
  environment: NodeJS.ProcessEnv,
  windowStartMs = 0,
) =>
  reader.kind === "scan"
    ? reader.scan({
        instances: [
          {
            instanceId: ProviderInstanceId.make("test"),
            config: undefined,
            environment,
            configured: true,
          },
        ],
        settings: DEFAULT_SERVER_SETTINGS,
        windowStartMs,
        retentionCutoffMs: 0,
        awaitRefresh: false,
      })
    : Effect.die("not a scan reader");

describe("harness stores on disk", () => {
  it.effect("counts every agent of a Kimi session under the session, and a grown log again", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kimi-usage-" });
      const session = path.join(home, "sessions", "wd_x", "session_1", "agents");
      for (const agent of ["main", "agent-0"]) {
        yield* fileSystem.makeDirectory(path.join(session, agent), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(session, agent, "wire.jsonl"),
          KIMI_LINE + "\n",
        );
      }
      yield* fileSystem.writeFileString(path.join(session, "notes.jsonl"), KIMI_LINE + "\n");

      const first = yield* scanWith(kimiUsageReader, { KIMI_CODE_HOME: home });
      const records = first.flatMap((source) => source.files ?? []).flatMap((file) => file.records);
      expect(records.map((record) => record.sessionId)).toEqual(["session_1", "session_1"]);

      yield* fileSystem.writeFileString(
        path.join(session, "main", "wire.jsonl"),
        KIMI_LINE + "\n" + KIMI_LINE + "\n",
      );
      const again = yield* scanWith(kimiUsageReader, { KIMI_CODE_HOME: home });
      expect(
        again.flatMap((source) => source.files ?? []).flatMap((file) => file.records),
      ).toHaveLength(3);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads pi's sessions and leaves out those last written before the window", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-usage-" });
      const sessions = path.join(home, "sessions", "--work--");
      yield* fileSystem.makeDirectory(sessions, { recursive: true });
      const file = path.join(sessions, "2026-09-28T12-28-44-844Z_01a0e7fd.jsonl");
      yield* fileSystem.writeFileString(file, PI_LINE + "\n");

      const scans = yield* scanWith(piUsageReader, { PI_CODING_AGENT_DIR: home });
      expect(
        scans.flatMap((source) => source.files ?? []).map((entry) => entry.records.length),
      ).toEqual([1]);
      // Last written at the start of September; a window opening in October leaves it out.
      yield* fileSystem.utimes(file, new Date("2026-09-01"), new Date("2026-09-01"));
      const later = yield* scanWith(
        piUsageReader,
        { PI_CODING_AGENT_DIR: home },
        Date.parse("2026-10-01T00:00:00Z"),
      );
      expect(later.flatMap((source) => source.files ?? [])).toEqual([]);
      const missing = yield* scanWith(piUsageReader, {
        PI_CODING_AGENT_DIR: path.join(home, "none"),
      });
      expect(missing.map((source) => source.files)).toEqual([null]);
      // Delivery is off in default settings, so the engine is never asked.
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
  );
});

describe("model providers of upstream's readers", () => {
  it("names Anthropic for Claude Code, which records none", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-28T12:00:00Z",
      sessionId: "s",
      message: { id: "m", model: "claude-fable-5", usage: { input_tokens: 3, output_tokens: 1 } },
    });
    expect(attributedClaudeUsageFormat.parseLine(line, undefined)).toMatchObject([
      { provider: "claude", modelProvider: "anthropic", modelProviderSource: "harness" },
    ]);
  });

  it("keeps the provider of a Codex rollout's own session_meta", () => {
    const state = attributedCodexUsageFormat.state!.initial();
    const lines = [
      { type: "session_meta", payload: { id: "c1", model_provider: "openai" } },
      { type: "session_meta", payload: { id: "parent", model_provider: "other" } },
      { type: "turn_context", payload: { model: "gpt-6-astra" } },
      {
        type: "event_msg",
        timestamp: "2026-09-28T12:00:00Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } },
        },
      },
    ].map((line) => JSON.stringify(line));
    const records = lines.flatMap((line) => attributedCodexUsageFormat.parseLine(line, state));
    expect(records).toMatchObject([
      {
        provider: "codex",
        sessionId: "c1",
        modelProvider: "openai",
        modelProviderSource: "recorded",
      },
    ]);
    expect(
      attributedCodexUsageFormat.parseProjected(
        { type: "session_meta", payload: { model_provider: "x" } },
        state,
      ),
    ).toEqual([]);
    expect(state.modelProvider).toBe("openai");
  });
});
