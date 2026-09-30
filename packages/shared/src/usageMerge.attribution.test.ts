import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeUsage } from "./usageMerge.ts";

const totals = (tokens: number) => ({
  uncachedInputTokens: tokens,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

function bucket(overrides: Partial<UsageBucket>): UsageBucket {
  return {
    day: "2026-09-28" as UsageDay,
    provider: "pi",
    model: "glm-5.3",
    totals: totals(100),
    costUsd: 0,
    cacheSavingsUsd: 0,
    costSource: "unpriced",
    records: 1,
    unpricedRecords: 1,
    sessions: 1,
    ...overrides,
  };
}

const HARNESSES = ["pi", "opencode", "hermes", "deepseek", "claude"] as const;

function merged(buckets: readonly UsageBucket[], filter = {}) {
  const summary: UsageSummary = {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-09-29T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-09-01" as UsageDay,
    untilDay: "2026-09-30" as UsageDay,
    buckets,
    sources: HARNESSES.map((provider) => ({
      fingerprint: { hostId: "host", provider, resolvedHomePath: `/${provider}`, volumeId: "v" },
      status: "ok" as const,
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 2,
      message: null,
    })),
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
  };
  return mergeUsage(
    [{ environmentId: "env" as EnvironmentId, label: "env", summary }],
    USAGE_CONTRACT_VERSION,
    filter,
  );
}

const BUCKETS = [
  bucket({ provider: "pi", modelProvider: "zai", modelProviderSource: "recorded" }),
  bucket({
    provider: "opencode",
    modelProvider: "zai",
    modelProviderSource: "recorded",
    totals: totals(200),
  }),
  bucket({
    provider: "hermes",
    modelProvider: "zai",
    modelProviderSource: "recorded",
    totals: totals(400),
  }),
  bucket({ provider: "deepseek", model: "model not recorded by DeepSeek", totals: totals(800) }),
  bucket({
    provider: "claude",
    model: "claude-fable-5-1",
    modelProvider: "anthropic",
    modelProviderSource: "harness",
    totals: totals(1600),
  }),
];

describe("usage by harness, provider and model", () => {
  it("keeps the same model apart by the harness it was used through", () => {
    const glm = merged(BUCKETS).models.filter((model) => model.model === "glm-5.3");
    expect(glm.map((model) => [model.provider, model.modelProvider, model.totalTokens])).toEqual([
      ["hermes", "zai", 400],
      ["opencode", "zai", 200],
      ["pi", "zai", 100],
    ]);
  });

  it("totals each provider across harnesses, and keeps usage of no recorded provider apart", () => {
    const providers = merged(BUCKETS).modelProviders;
    expect(
      providers.map((entry) => [
        entry.modelProvider,
        entry.modelProviderSource,
        entry.totalTokens,
        entry.harnesses,
      ]),
    ).toEqual([
      ["anthropic", "harness", 1600, ["claude"]],
      [null, null, 800, ["deepseek"]],
      ["zai", "recorded", 700, ["hermes", "opencode", "pi"]],
    ]);
  });

  it("narrows by harness, with the sessions of those harnesses", () => {
    const narrowed = merged(BUCKETS, { harnesses: new Set(["pi", "hermes"]) });
    expect([narrowed.totalTokens, narrowed.sessions, narrowed.sessionsUnfiltered]).toEqual([
      500,
      4,
      false,
    ]);
  });

  it("narrows by provider and model, and says the sessions are not narrowed", () => {
    const narrowed = merged(BUCKETS, {
      modelProviders: new Set(["zai"]),
      models: new Set(["glm-5.3"]),
    });
    expect(narrowed.totalTokens).toBe(700);
    expect(narrowed.sessionsUnfiltered).toBe(true);
    expect(merged(BUCKETS, { modelProviders: new Set([""]) }).totalTokens).toBe(800);
  });
});
