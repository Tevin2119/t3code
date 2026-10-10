import { ProviderDriverKind } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { zaiQuotaResponseToLimits } from "@t3tools/provider-core/server/zaiUsageLimits";

import { mergeOpenCodeUsageLimits, readOpenCodeZaiUsageLimits } from "./usageLimits.ts";

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
