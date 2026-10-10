import { describe, expect, it } from "@effect/vitest";

import { chatGptQuotaGroup, chatGptUsageResponseToLimits } from "./usageLimits.ts";

const checkedAt = "2026-09-27T09:00:00.000Z";

describe("chatGptUsageResponseToLimits", () => {
  it("identifies a shared ChatGPT account without retaining the bearer token", () => {
    const payload = Buffer.from(
      '{"https://api.openai.com/profile":{"email":"Same@Example.com"}}',
    ).toString("base64url");
    expect(chatGptQuotaGroup(`header.${payload}.signature`)).toEqual({
      driver: "codex",
      accountKey: "codex:same@example.com",
      label: "ChatGPT",
    });
    expect(chatGptQuotaGroup("invalid")).toBeUndefined();
  });
  it("names a lone weekly window by its duration, not its position", () => {
    const limits = chatGptUsageResponseToLimits(
      {
        plan_type: "prolite",
        rate_limit: {
          primary_window: { used_percent: 9, limit_window_seconds: 604800, reset_at: 1791102562 },
          secondary_window: null,
        },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual([
      {
        id: "primary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 9,
        windowDurationMins: 10080,
        resetsAt: "2026-10-04T08:29:22.000Z",
      },
    ]);
    expect(chatGptUsageResponseToLimits({}, checkedAt).unavailable?.reason).toBe("unsupported");
  });
});
