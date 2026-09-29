import { describe, expect, it } from "vite-plus/test";

import {
  buildPiRpcArgs,
  chosenPiThinkingLevel,
  piFailureFromRecord,
  piUsageFromStats,
} from "./PiAdapter.ts";

describe("buildPiRpcArgs", () => {
  it("passes the chosen reasoning level to pi, before what the team adds", () => {
    expect(
      buildPiRpcArgs({
        provider: "openai-codex",
        model: "openai-codex/gpt-6-luna",
        thinking: "high",
        teamArgs: ["--append-system-prompt", "instructions.md"],
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--provider",
      "openai-codex",
      "--model",
      "openai-codex/gpt-6-luna",
      "--thinking",
      "high",
      "--append-system-prompt",
      "instructions.md",
    ]);
  });

  it("leaves the level to pi when none is given", () => {
    expect(buildPiRpcArgs({ provider: "kimi-coding", model: undefined })).toEqual([
      "--mode",
      "rpc",
      "--provider",
      "kimi-coding",
    ]);
  });
});

describe("what pi reports", () => {
  it("leaves pi on its own level when none was chosen", () => {
    const selection = (value: string) =>
      ({ instanceId: "pi", model: "m", options: [{ id: "thinking", value }] }) as never;
    expect(chosenPiThinkingLevel(undefined)).toBeUndefined();
    expect(chosenPiThinkingLevel(selection("harness-default"))).toBeUndefined();
    expect(chosenPiThinkingLevel(selection("high"))).toBe("high");
  });

  it("reads the context window and what was used from the session stats", () => {
    expect(
      piUsageFromStats({
        tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
        cost: 0.45,
        contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 },
      }),
    ).toEqual({
      usedTokens: 60000,
      maxTokens: 200000,
      totalProcessedTokens: 105000,
      inputTokens: 50000,
      outputTokens: 10000,
      cachedInputTokens: 40000,
    });
    // Just after a compaction pi does not know what the context holds.
    expect(
      piUsageFromStats({
        tokens: { total: 900 },
        contextUsage: { tokens: null, contextWindow: 200000 },
      }),
    ).toEqual({ usedTokens: 900, maxTokens: 200000, totalProcessedTokens: 900 });
    expect(piUsageFromStats({})).toBeUndefined();
  });

  it("takes a failed model call for a failed turn", () => {
    expect(
      piFailureFromRecord({ type: "auto_retry_end", success: false, finalError: "overloaded" }),
    ).toBe("overloaded");
    expect(piFailureFromRecord({ type: "auto_retry_end", success: true })).toBeUndefined();
    expect(
      piFailureFromRecord({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "no credit" },
      }),
    ).toBe("no credit");
    expect(
      piFailureFromRecord({
        type: "message_end",
        message: { role: "assistant", stopReason: "stop" },
      }),
    ).toBeUndefined();
  });
});
