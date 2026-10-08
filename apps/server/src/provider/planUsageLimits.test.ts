// @effect-diagnostics nodeBuiltinImport:off - joins paths inside a scoped temp directory.
import * as NodePath from "node:path";
import { ProviderDriverKind } from "@t3tools/contracts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";

import { parseDotenv, readHermesUsageLimits } from "./hermesUsageLimits.ts";
import {
  kimiBaseUrlFromConfig,
  kimiUsageResponseToLimits,
  readKimiUsageLimits,
} from "./kimiUsageLimits.ts";
import { mergeOpenCodeUsageLimits, readOpenCodeZaiUsageLimits } from "./openCodeUsageLimits.ts";
import { chatGptQuotaGroup, chatGptUsageResponseToLimits } from "./piUsageLimits.ts";
import { zaiOriginForBaseUrl, zaiQuotaResponseToLimits } from "./zaiUsageLimits.ts";

const checkedAt = "2026-09-27T09:00:00.000Z";

// Shaped like a Pro coding plan's answer: a five-hour and a weekly allowance.
const ZAI_RESPONSE = {
  success: true,
  data: {
    limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 12, nextResetTime: 1790515765096 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 140, nextResetTime: 1790961490972 },
    ],
  },
};

const jsonClient = (
  body: unknown,
  inspect: (request: { readonly url: string; readonly authorization: string | undefined }) => void,
) =>
  HttpClient.make((request) => {
    inspect({ url: request.url, authorization: request.headers.authorization });
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
  });

describe("zaiQuotaResponseToLimits", () => {
  it("maps the hour and week units onto session and weekly windows", () => {
    expect(zaiQuotaResponseToLimits(ZAI_RESPONSE, checkedAt, "GLM · ").windows).toEqual([
      {
        id: "zai_credit_limit_3_5",
        kind: "session",
        label: "GLM · Session",
        usedPercent: 12,
        windowDurationMins: 300,
        resetsAt: "2026-09-27T13:29:25.096Z",
      },
      {
        id: "zai_credit_limit_6_1",
        kind: "weekly",
        label: "GLM · Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
        resetsAt: "2026-10-02T17:18:10.972Z",
      },
    ]);
  });

  it("keeps an unknown unit as an unlabelled quota and reports no plan as unsupported", () => {
    const limits = zaiQuotaResponseToLimits(
      { data: { limits: [{ type: "TIME_LIMIT", unit: 9, number: 1, percentage: 4 }] } },
      checkedAt,
    );
    expect(limits.windows).toEqual([
      { id: "zai_time_limit_9_1", kind: "other", label: "Quota", usedPercent: 4 },
    ]);
    for (const response of [{}, { data: {} }, { data: { limits: [{ unit: 3, number: 5 }] } }]) {
      expect(zaiQuotaResponseToLimits(response, checkedAt).unavailable?.reason).toBe("unsupported");
    }
  });

  it("selects the mainland deployment from its base URL", () => {
    expect(zaiOriginForBaseUrl("https://open.bigmodel.cn/api/coding/paas/v4")).toBe(
      "https://open.bigmodel.cn",
    );
    expect(zaiOriginForBaseUrl("https://api.z.ai/api/coding/paas/v4")).toBe("https://api.z.ai");
    expect(zaiOriginForBaseUrl(undefined)).toBe("https://api.z.ai");
  });
});

describe("parseDotenv", () => {
  it("reads plain, quoted and exported values and skips comments", () => {
    expect(
      parseDotenv(
        ["# GLM_API_KEY=old", 'GLM_API_KEY="abc.def"', "export ZAI_API_KEY=xyz # note", ""].join(
          "\r\n",
        ),
      ),
    ).toEqual({ GLM_API_KEY: "abc.def", ZAI_API_KEY: "xyz" });
  });
});

it.layer(NodeServices.layer)("readHermesUsageLimits", (it) => {
  it.effect("reads the Z.AI key from the Hermes home when Hermes runs on Z.AI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(NodePath.join(directory, ".env"), "GLM_API_KEY=glm.key\n");
      const limits = yield* readHermesUsageLimits({
        provider: "zai",
        environment: { HERMES_HOME: directory },
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          jsonClient(ZAI_RESPONSE, (request) => {
            expect(request.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
            expect(request.authorization).toBe("Bearer glm.key");
          }),
        ),
      );
      expect(limits.windows.map((window) => [window.kind, window.usedPercent])).toEqual([
        ["session", 12],
        ["weekly", 100],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("never sends a key when Hermes runs on another provider or holds no key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const noRequest = HttpClient.make(() => Effect.die("must not call Z.AI"));
      const otherProvider = yield* readHermesUsageLimits({
        provider: "deepseek",
        environment: { HERMES_HOME: directory, GLM_API_KEY: "glm.key" },
      }).pipe(Effect.provideService(HttpClient.HttpClient, noRequest));
      expect(otherProvider.unavailable?.reason).toBe("unsupported");
      const noKey = yield* readHermesUsageLimits({
        provider: "zai",
        environment: { HERMES_HOME: directory },
      }).pipe(Effect.provideService(HttpClient.HttpClient, noRequest));
      expect(noKey.unavailable?.reason).toBe("unsupported");
    }).pipe(Effect.scoped),
  );
});

describe("kimiUsageResponseToLimits", () => {
  it("turns used ratios into percentages, and shows Code as a part of the monthly limit", () => {
    // Shaped after the real response of 2026-09-30.
    const limits = kimiUsageResponseToLimits(
      {
        usages: {
          limit_5h: { used_ratio: 0.25, reset_time: "2026-09-27T13:48:00Z" },
          limit_month_total: { used_ratio: 0.0454, reset_time: "2026-10-26T00:00:00Z" },
          limit_month_code: { used_ratio: 0.01, reset_time: "2026-10-26T00:00:00Z" },
        },
      },
      checkedAt,
    );
    expect(
      limits.windows.map((window) => [window.id, window.kind, window.label, window.usedPercent]),
    ).toEqual([
      ["kimi_limit_5h", "session", "Session", 25],
      [
        "kimi_limit_month_total",
        "monthly",
        "Monthly · used by Code 1%, by Kimi 3.5%",
        expect.closeTo(4.54, 5),
      ],
    ]);
    // With no Code figure, the monthly window keeps its plain name.
    expect(
      kimiUsageResponseToLimits(
        { usages: { limit_month_total: { used_ratio: 0.2 } } },
        checkedAt,
      ).windows.map((window) => window.label),
    ).toEqual(["Monthly"]);
    expect(limits.windows[0]?.resetsAt).toBe("2026-09-27T13:48:00.000Z");
    expect(kimiUsageResponseToLimits({}, checkedAt).unavailable?.reason).toBe("unsupported");
  });

  it("reads the managed provider's base URL and ignores other providers", () => {
    const config = [
      'default_model = "kimi-code/k3"',
      "",
      '[providers."other"]',
      'base_url = "https://example.test/v1"',
      "",
      '[providers."managed:kimi-code"]',
      'type = "kimi"',
      'base_url = "https://api.kimi.ai/coding/v1"',
      "",
      '[providers."managed:kimi-code".oauth]',
      'oauth_host = "https://auth.kimi.ai"',
    ].join("\n");
    expect(kimiBaseUrlFromConfig(config)).toBe("https://api.kimi.ai/coding/v1");
    expect(kimiBaseUrlFromConfig('[providers."other"]\nbase_url = "https://x.test"')).toBe(
      undefined,
    );
  });
});

it.layer(NodeServices.layer)("readKimiUsageLimits", (it) => {
  // Effect tests run on a clock that starts at the epoch, so expiry is counted from zero.
  const writeHome = Effect.fn(function* (expiresAt: number) {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(NodePath.join(directory, "credentials"));
    yield* fs.writeFileString(
      NodePath.join(directory, "credentials", "kimi-code-env-0e4f.json"),
      `{"access_token":"kimi-token","refresh_token":"r","expires_at":${expiresAt}}`,
    );
    yield* fs.writeFileString(
      NodePath.join(directory, "config.toml"),
      '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.ai/coding/v1/"\n',
    );
    return directory;
  });

  it.effect("asks the configured region with a live token", () =>
    Effect.gen(function* () {
      const directory = yield* writeHome(600);
      const limits = yield* readKimiUsageLimits({ KIMI_CODE_HOME: directory }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          jsonClient({ usages: { limit_5h: { used_ratio: 0.5 } } }, (request) => {
            expect(request.url).toBe("https://api.kimi.ai/coding/v1/usages");
            expect(request.authorization).toBe("Bearer kimi-token");
          }),
        ),
      );
      expect(limits.windows[0]?.usedPercent).toBe(50);
    }).pipe(Effect.scoped),
  );

  it.effect("does not send an expired access token when refresh is rejected", () =>
    Effect.gen(function* () {
      const directory = yield* writeHome(10);
      const limits = yield* readKimiUsageLimits({ KIMI_CODE_HOME: directory }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.url).toBe("https://auth.kimi.ai/api/oauth/token");
            expect(request.headers.authorization).toBeUndefined();
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("{}", { status: 401 })),
            );
          }),
        ),
      );
      expect(limits.unavailable?.reason).toBe("probeFailed");
    }).pipe(Effect.scoped),
  );

  it.effect("reports an install without a Kimi account sign-in as unsupported", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const limits = yield* readKimiUsageLimits({ KIMI_CODE_HOME: directory }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("must not call Kimi")),
        ),
      );
      expect(limits.unavailable?.reason).toBe("unsupported");
    }).pipe(Effect.scoped),
  );
});

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

it.layer(NodeServices.layer)("readOpenCodeZaiUsageLimits", (it) => {
  it.effect("reads the coding plan key OpenCode stores and prefixes the plan name", () =>
    Effect.gen(function* () {
      const limits = yield* readOpenCodeZaiUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: {
          OPENCODE_AUTH_CONTENT: '{"zai-coding-plan":{"type":"api","key":"glm.key"}}',
        },
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          jsonClient(ZAI_RESPONSE, (request) => {
            expect(request.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
            expect(request.authorization).toBe("Bearer glm.key");
          }),
        ),
      );
      expect(limits.windows.map((window) => window.label)).toEqual([
        "GLM · Session",
        "GLM · Weekly",
      ]);
    }),
  );

  it.effect("leaves external servers and installs without the plan alone", () =>
    Effect.gen(function* () {
      const noRequest = HttpClient.make(() => Effect.die("must not call Z.AI"));
      for (const input of [
        { enabled: true, serverUrl: "http://remote:4096", environment: {} },
        { enabled: true, serverUrl: "", environment: { OPENCODE_AUTH_CONTENT: "{}" } },
      ]) {
        const limits = yield* readOpenCodeZaiUsageLimits(input).pipe(
          Effect.provideService(HttpClient.HttpClient, noRequest),
        );
        expect(limits.unavailable?.reason).toBe("unsupported");
      }
    }),
  );
});

describe("mergeOpenCodeUsageLimits", () => {
  const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
  const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
  const glm = zaiQuotaResponseToLimits(ZAI_RESPONSE, checkedAt, "GLM · ");

  it("shows the plans that reported and hides a failure beside them", () => {
    expect(mergeOpenCodeUsageLimits(checkedAt, [failed, glm]).windows).toHaveLength(2);
    expect(mergeOpenCodeUsageLimits(checkedAt, [failed, glm]).unavailable).toBeUndefined();
  });

  it("reports a failure only when no plan reported", () => {
    expect(mergeOpenCodeUsageLimits(checkedAt, [unsupported, failed]).unavailable?.reason).toBe(
      "probeFailed",
    );
    expect(
      mergeOpenCodeUsageLimits(checkedAt, [unsupported, unsupported]).unavailable?.reason,
    ).toBe("unsupported");
  });
  it("preserves a single plan's account group but never merges mixed subscriptions", () => {
    const group = {
      driver: ProviderDriverKind.make("hermes"),
      accountKey: "zai:one",
      label: "GLM Coding Plan",
    };
    const grouped = { ...glm, quotaGroup: group };
    expect(mergeOpenCodeUsageLimits(checkedAt, [unsupported, grouped]).quotaGroup).toEqual(group);
    expect(mergeOpenCodeUsageLimits(checkedAt, [glm, grouped]).quotaGroup).toBeUndefined();
  });
});
