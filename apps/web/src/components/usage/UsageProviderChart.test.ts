import { describe, expect, it } from "vite-plus/test";

import { buildPeriodColumns } from "./UsageProviderChart";
import { PROVIDER_ORDER } from "./usageProviders";

describe("buildPeriodColumns", () => {
  const days = ["2026-08-01", "2026-08-02", "2026-08-03"];
  const byDay = new Map([
    [
      "2026-08-01",
      {
        day: "2026-08-01",
        costUsd: 42,
        totalTokens: 420,
        byProvider: new Map([
          ["codex" as const, { costUsd: 10, totalTokens: 100 }],
          ["claude" as const, { costUsd: 20, totalTokens: 200 }],
          ["pi" as const, { costUsd: 5, totalTokens: 50 }],
          ["muse" as const, { costUsd: 7, totalTokens: 70 }],
        ]),
      },
    ],
    [
      "2026-08-03",
      {
        day: "2026-08-03",
        costUsd: 5,
        totalTokens: 50,
        byProvider: new Map([["claude" as const, { costUsd: 5, totalTokens: 50 }]]),
      },
    ],
  ]);

  it("keeps band values absolute rather than cumulative", () => {
    const [first] = buildPeriodColumns(days, byDay, "cost");

    // One band per harness, in the shared reading order; harnesses with no usage are zero.
    expect(first?.bands).toEqual(
      PROVIDER_ORDER.map((provider) => ({
        provider,
        value:
          provider === "codex"
            ? 10
            : provider === "claude"
              ? 20
              : provider === "pi"
                ? 5
                : provider === "muse"
                  ? 7
                  : 0,
      })),
    );
  });
});
