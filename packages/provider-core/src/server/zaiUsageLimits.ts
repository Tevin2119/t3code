// @effect-diagnostics nodeBuiltinImport:off - credential fingerprints use a pure synchronous SHA-256 digest.
/**
 * Z.AI (GLM) coding plan usage. The plan is reached through other harnesses
 * (Hermes, OpenCode), so this module only maps and fetches; each driver decides
 * where the key comes from.
 *
 * FORK-ONLY. Shared by the OpenCode package and the fork's Hermes driver.
 *
 * @module provider-core/server/zaiUsageLimits
 */
import * as NodeCrypto from "node:crypto";

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

import { clampPercent, makeUnavailableUsageLimits, makeUsageLimits } from "./usageLimits.ts";

const ZAI_QUOTA_PATH = "/api/monitor/usage/quota/limit";
/** The international and mainland China deployments hold separate accounts. */
export const ZAI_ORIGIN = "https://api.z.ai";
export const ZHIPU_ORIGIN = "https://open.bigmodel.cn";

const ZaiLimit = Schema.Struct({
  type: Schema.optional(Schema.String),
  unit: Schema.optional(Schema.Finite),
  number: Schema.optional(Schema.Finite),
  percentage: Schema.optional(Schema.Finite),
  nextResetTime: Schema.optional(Schema.Finite),
});
export const ZaiQuotaResponse = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  data: Schema.optional(
    Schema.Struct({
      limits: Schema.optional(Schema.Array(ZaiLimit)),
    }),
  ),
});

const HOUR_MINS = 60;
const DAY_MINS = 24 * HOUR_MINS;
const WEEK_MINS = 7 * DAY_MINS;

/** `unit` 3 counts hours and 6 counts weeks; other units stay unlabelled. */
function windowDurationMins(limit: typeof ZaiLimit.Type): number | undefined {
  const count = limit.number;
  if (count === undefined || !Number.isFinite(count) || count <= 0) return undefined;
  if (limit.unit === 3) return count * HOUR_MINS;
  if (limit.unit === 6) return count * WEEK_MINS;
  return undefined;
}

function kindForDuration(mins: number | undefined): ServerProviderUsageWindow["kind"] {
  if (mins === undefined) return "other";
  if (mins >= 28 * DAY_MINS) return "monthly";
  if (mins >= WEEK_MINS) return "weekly";
  return "session";
}

function labelForKind(kind: ServerProviderUsageWindow["kind"]): string {
  switch (kind) {
    case "session":
      return "Session";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    default:
      return "Quota";
  }
}

/** `labelPrefix` names the plan when the harness can also report another one. */
export function zaiQuotaResponseToLimits(
  response: typeof ZaiQuotaResponse.Type,
  checkedAt: string,
  labelPrefix = "",
): ServerProviderUsageLimits {
  const windows: ServerProviderUsageWindow[] = [];
  for (const limit of response.data?.limits ?? []) {
    if (limit.percentage === undefined || !Number.isFinite(limit.percentage)) continue;
    const durationMins = windowDurationMins(limit);
    const kind = kindForDuration(durationMins);
    const reset =
      limit.nextResetTime !== undefined && limit.nextResetTime > 0
        ? DateTime.make(limit.nextResetTime)
        : Option.none();
    windows.push({
      id: `zai_${(limit.type ?? "limit").toLowerCase()}_${limit.unit ?? 0}_${limit.number ?? 0}`,
      kind,
      label: `${labelPrefix}${labelForKind(kind)}`,
      usedPercent: clampPercent(limit.percentage),
      ...(durationMins !== undefined ? { windowDurationMins: durationMins } : {}),
      ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
    });
  }
  if (windows.length === 0) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  return makeUsageLimits({ checkedAt, windows });
}

/** A base URL on the mainland deployment selects its quota endpoint. */
export function zaiOriginForBaseUrl(baseUrl: string | undefined): string {
  return baseUrl && /bigmodel\.cn/i.test(baseUrl) ? ZHIPU_ORIGIN : ZAI_ORIGIN;
}

export const fetchZaiUsageLimits = Effect.fn("fetchZaiUsageLimits")(function* (input: {
  readonly apiKey: string;
  readonly origin: string;
  readonly checkedAt: string;
  readonly labelPrefix?: string;
}) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.get(`${input.origin}${ZAI_QUOTA_PATH}`).pipe(
      HttpClientRequest.bearerToken(input.apiKey),
      HttpClientRequest.setHeader("Accept-Language", "en-US,en"),
    ),
  );
  const body = yield* HttpClientResponse.schemaBodyJson(ZaiQuotaResponse)(
    yield* HttpClientResponse.filterStatusOk(response),
  );
  // A pay-as-you-go key answers without plan windows.
  if (body.success === false) {
    return makeUnavailableUsageLimits({ checkedAt: input.checkedAt, reason: "unsupported" });
  }
  const limits = zaiQuotaResponseToLimits(body, input.checkedAt, input.labelPrefix);
  return {
    ...limits,
    quotaGroup: {
      driver: ProviderDriverKind.make("hermes"),
      accountKey: `zai:${NodeCrypto.createHash("sha256").update(`${input.origin}\n${input.apiKey.trim()}`).digest("hex")}`,
      label: "GLM Coding Plan",
    },
  };
});
