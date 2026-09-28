/**
 * pi subscription usage. pi fronts several backends and holds one credential
 * per backend, so limits exist only for a backend that sells a plan with
 * rolling windows and whose token pi can hand over. Today that is a ChatGPT
 * plan, reached through pi's `openai-codex` provider.
 *
 * The token comes from `pi auth print-bearer-token`, which refreshes an expired
 * sign-in, so this probe never reads or rewrites pi's credential file.
 *
 * @module provider/Layers/piUsageLimits
 */
import {
  ProviderDriverKind,
  type PiSettings,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { makeUnavailableUsageLimits } from "../providerUsageLimits.ts";
import { codexRateLimitsToLimits } from "./codexUsageLimits.ts";
import { runPiCliCommand } from "./PiProvider.ts";

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CHATGPT_PROVIDER = "openai-codex";
const TokenIdentity = Schema.Struct({
  email: Schema.optional(Schema.String),
  "https://api.openai.com/profile": Schema.optional(
    Schema.Struct({ email: Schema.optional(Schema.String) }),
  ),
});
const decodeTokenIdentity = Schema.decodeUnknownOption(Schema.fromJsonString(TokenIdentity));

/** Used only after the usage endpoint accepts this bearer token. Never exposes the token. */
export function chatGptQuotaGroup(token: string): ServerProviderUsageLimits["quotaGroup"] {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  const identity = decodeTokenIdentity(Buffer.from(payload, "base64url").toString("utf8"));
  if (identity._tag === "None") return undefined;
  const email = (identity.value["https://api.openai.com/profile"]?.email ?? identity.value.email)
    ?.trim()
    .toLowerCase();
  return email
    ? { driver: ProviderDriverKind.make("codex"), accountKey: `codex:${email}`, label: "ChatGPT" }
    : undefined;
}

const ChatGptWindow = Schema.Struct({
  used_percent: Schema.Finite,
  limit_window_seconds: Schema.optional(Schema.NullOr(Schema.Finite)),
  reset_at: Schema.optional(Schema.NullOr(Schema.Finite)),
});
export const ChatGptUsageResponse = Schema.Struct({
  plan_type: Schema.optional(Schema.NullOr(Schema.String)),
  rate_limit: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        primary_window: Schema.optional(Schema.NullOr(ChatGptWindow)),
        secondary_window: Schema.optional(Schema.NullOr(ChatGptWindow)),
      }),
    ),
  ),
});

function toCodexWindow(window: typeof ChatGptWindow.Type | null | undefined) {
  if (!window) return null;
  return {
    usedPercent: window.used_percent,
    resetsAt: window.reset_at ?? null,
    windowDurationMins:
      typeof window.limit_window_seconds === "number"
        ? Math.round(window.limit_window_seconds / 60)
        : null,
  };
}

/** The same windows the Codex driver reports, so both read alike on the Limits page. */
export function chatGptUsageResponseToLimits(
  response: typeof ChatGptUsageResponse.Type,
  checkedAt: string,
): ServerProviderUsageLimits {
  const limits = codexRateLimitsToLimits({
    snapshot: {
      planType: response.plan_type ?? null,
      primary: toCodexWindow(response.rate_limit?.primary_window),
      secondary: toCodexWindow(response.rate_limit?.secondary_window),
    },
    checkedAt,
  });
  return limits.windows.length > 0
    ? limits
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

export const readPiUsageLimits = Effect.fn("readPiUsageLimits")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const provider = piSettings.provider.trim() || "kimi-coding";
  if (provider !== CHATGPT_PROVIDER) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }

  return yield* Effect.gen(function* () {
    const result = yield* runPiCliCommand(
      piSettings,
      ["auth", "print-bearer-token", "--provider", provider],
      environment,
    );
    const token = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.length > 0);
    if (result.code !== 0 || !token) return yield* Effect.fail("no-token" as const);

    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(CHATGPT_USAGE_URL).pipe(HttpClientRequest.bearerToken(token)),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(ChatGptUsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    const quotaGroup = chatGptQuotaGroup(token);
    return {
      ...chatGptUsageResponseToLimits(body, checkedAt),
      ...(quotaGroup ? { quotaGroup } : {}),
    };
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "pi could not read usage limits.",
      }),
    ),
  );
});
