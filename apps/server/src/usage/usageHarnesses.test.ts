import { describe, expect, it } from "@effect/vitest";

import { UsageAggregator } from "./usageAggregation.ts";
import { hermesRecordFrom, openCodeRecordFrom } from "./usageDatabases.ts";
import { sessionIdFromPath } from "./usageTranscriptReader.ts";
import { parseKimiLine, parsePiLine, type UsageRecord } from "./usageTranscripts.ts";

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
    expect(sessionIdFromPath("/p/2026-09-28T12-28-44-844Z_01a0e7fd-2fab.jsonl", "pi")).toBe(
      "01a0e7fd-2fab",
    );
    expect(sessionIdFromPath("/k/sessions/abc/sess-1/wire.jsonl", "kimi")).toBe("sess-1");
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

describe("OpenCode", () => {
  const row = (data: Record<string, unknown>) => ({
    id: "msg_1",
    session_id: "ses_1",
    time_created: 1790719302282,
    data: JSON.stringify(data),
  });
  const message = {
    role: "assistant",
    cost: 0,
    tokens: { input: 1337, output: 1810, reasoning: 88, cache: { write: 0, read: 46144 } },
    modelID: "glm-5.3",
    providerID: "zai-coding-plan",
    time: { created: 1790719302282, completed: 1790719328306 },
  };

  it("counts reasoning within the output, and a cost of zero as no cost", () => {
    expect(openCodeRecordFrom(row(message))).toMatchObject({
      provider: "opencode",
      model: "glm-5.3",
      modelProvider: "zai-coding-plan",
      timestampMs: 1790719328306,
      reportedCostUsd: null,
      dedupeKey: "opencode:msg_1",
      totals: {
        uncachedInputTokens: 1337,
        cachedInputTokens: 46144,
        outputTokens: 1898,
        reasoningTokens: 88,
      },
    });
  });

  it("reads nothing from a person's message", () => {
    expect(openCodeRecordFrom(row({ ...message, role: "user" }))).toBeNull();
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
