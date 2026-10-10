/**
 * pi subscription usage. pi fronts several backends and holds one credential
 * per backend, so limits exist only for a backend that sells a plan with
 * rolling windows and whose token pi can hand over. Today that is a ChatGPT
 * plan, reached through pi's `openai-codex` provider.
 *
 * The token comes from `pi auth print-bearer-token`, which refreshes an expired
 * sign-in, so this probe never reads or rewrites pi's credential file.
 *
 * FORK-ONLY.
 *
 * @module provider-pi/server/usageLimits
 */
import {
  ProviderDriverKind,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import type { PiSettings } from "../settings.ts";
import { runPiCliCommand } from "./status.ts";

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

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

function kindForDuration(mins: number): ServerProviderUsageWindow["kind"] {
  if (mins >= MONTH_MINS) return "monthly";
  if (mins >= WEEK_MINS) return "weekly";
  return "session";
}

function isoFromEpochSeconds(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

/**
 * The same windows the Codex driver reports for a ChatGPT plan (see
 * apps/server codexUsageLimits), so both read alike on the Limits page.
 * `primary` and `secondary` are positions, not durations: without a stated
 * duration, Free and Go plans have one monthly allowance and paid plans a
 * 5-hour and weekly pair.
 */
export function chatGptUsageResponseToLimits(
  response: typeof ChatGptUsageResponse.Type,
  checkedAt: string,
): ServerProviderUsageLimits {
  const isMonthlyPlan = response.plan_type === "free" || response.plan_type === "go";
  const positions = [
    ["primary", response.rate_limit?.primary_window, isMonthlyPlan ? MONTH_MINS : SESSION_MINS],
    ["secondary", response.rate_limit?.secondary_window, WEEK_MINS],
  ] as const;
  const windows: ServerProviderUsageWindow[] = [];
  for (const [id, window, fallbackMins] of positions) {
    if (!window || !Number.isFinite(window.used_percent)) continue;
    const windowDurationMins =
      typeof window.limit_window_seconds === "number"
        ? Math.round(window.limit_window_seconds / 60)
        : fallbackMins;
    const kind = kindForDuration(windowDurationMins);
    const resetsAt = isoFromEpochSeconds(window.reset_at);
    windows.push({
      id,
      kind,
      label: kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : "Monthly",
      usedPercent: clampPercent(window.used_percent),
      windowDurationMins,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

export const readPiUsageLimits = Effect.fn("readPiUsageLimits")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const provider = piSettings.provider?.trim() || "kimi-coding";
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
