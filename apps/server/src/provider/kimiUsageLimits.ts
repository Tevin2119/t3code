/**
 * Kimi Code plan usage, read with the account the CLI is signed in to.
 *
 * Uses the configured OAuth slot and refresh grant, without starting a chat.
 * Refreshes are serialized here; a concurrent CLI credential change wins.
 *
 * @module provider/Layers/kimiUsageLimits
 */
import * as NodeOS from "node:os";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
/** Leave room for the request itself before the token lapses. */
const EXPIRY_MARGIN_SECONDS = 30;
const refreshLock = Semaphore.makeUnsafe(1);
const credentialRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeRecord = Schema.decodeEffect(credentialRecord);
const encodeRecord = Schema.encodeEffect(credentialRecord);
const RefreshResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optional(Schema.NonEmptyString),
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)),
});

const KimiCredential = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.Finite),
  refresh_token: Schema.optional(Schema.String),
});
const decodeCredential = Schema.decodeEffect(Schema.fromJsonString(KimiCredential));

const KimiUsageEntry = Schema.Struct({
  used_ratio: Schema.optional(Schema.Finite),
  reset_time: Schema.optional(Schema.String),
});
export const KimiUsageResponse = Schema.Struct({
  usages: Schema.optional(Schema.Record(Schema.String, KimiUsageEntry)),
});

function windowForUsage(
  name: string,
  entry: typeof KimiUsageEntry.Type,
): ServerProviderUsageWindow | undefined {
  if (entry.used_ratio === undefined || !Number.isFinite(entry.used_ratio)) return undefined;
  const kind: ServerProviderUsageWindow["kind"] = /(^|_)5h($|_)/.test(name)
    ? "session"
    : /week/.test(name)
      ? "weekly"
      : /month/.test(name)
        ? "monthly"
        : "other";
  const base =
    kind === "session"
      ? "Session"
      : kind === "weekly"
        ? "Weekly"
        : kind === "monthly"
          ? "Monthly"
          : "Quota";
  const label = base;
  const reset = entry.reset_time ? DateTime.make(entry.reset_time) : Option.none();
  return {
    id: `kimi_${name}`,
    kind,
    label,
    usedPercent: clampPercent(entry.used_ratio * 100),
    ...(kind === "session" ? { windowDurationMins: SESSION_MINS } : {}),
    ...(kind === "weekly" ? { windowDurationMins: WEEK_MINS } : {}),
    ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
  };
}

/** One share of a ratio, as a person reads it: 4.5%, <0.1%, 0%. */
const shareText = (ratio: number): string => {
  const percent = clampPercent(ratio * 100);
  if (percent === 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  return `${Math.round(percent * 10) / 10}%`;
};

/**
 * `limit_month_code` is not an allowance of its own. Kimi's own CLI and web app show one
 * monthly limit (`limit_month_total`) and split what was used of it in two: Code, the ratio
 * of `limit_month_code`, and Kimi, the rest (total minus code). So Code is folded into the
 * monthly window's label, in Kimi's words, and never shown as a quota with its own "left".
 * Which use Kimi counts as Code is not documented, and the label does not guess.
 */
export function kimiUsageResponseToLimits(
  response: typeof KimiUsageResponse.Type,
  checkedAt: string,
): ServerProviderUsageLimits {
  const usages = response.usages ?? {};
  const code = usages["limit_month_code"]?.used_ratio;
  const total = usages["limit_month_total"]?.used_ratio;
  const windows = Object.entries(usages).flatMap(([name, entry]) => {
    if (name === "limit_month_code") return [];
    const window = windowForUsage(name, entry);
    if (!window) return [];
    if (
      name === "limit_month_total" &&
      total !== undefined &&
      code !== undefined &&
      Number.isFinite(code)
    ) {
      const other = Math.max(0, Math.round((total - code) * 1e6) / 1e6);
      return [
        {
          ...window,
          label: `Monthly · used by Code ${shareText(code)}, by Kimi ${shareText(other)}`,
        },
      ];
    }
    return [window];
  });
  if (windows.length === 0) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  return makeUsageLimits({ checkedAt, windows });
}

/** The managed provider's `base_url` in the CLI's `config.toml`, when it names one. */
export function kimiBaseUrlFromConfig(config: string): string | undefined {
  const section = /^\[providers\."managed:kimi-code"\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(
    config,
  );
  const match = section?.[1] ? /^\s*base_url\s*=\s*"([^"]+)"/m.exec(section[1]) : null;
  return match?.[1]?.trim() || undefined;
}

export function kimiOAuthFromConfig(config: string) {
  const section =
    /^\[providers\."managed:kimi-code"\.oauth\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(
      config,
    )?.[1] ?? "";
  const key = /^\s*key\s*=\s*"oauth\/(kimi-code[\w-]*)"/m.exec(section)?.[1];
  const host = /^\s*oauth_host\s*=\s*"([^"]+)"/m.exec(section)?.[1];
  return { key, host };
}

const refreshCredential = Effect.fn("refreshKimiUsageCredential")(function* (
  filename: string,
  host: string,
  nowSeconds: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const original = yield* fs.readFileString(filename);
  const saved = yield* decodeRecord(original);
  const token = yield* decodeCredential(original);
  if ((token.expires_at ?? 0) >= nowSeconds + EXPIRY_MARGIN_SECONDS) return token.access_token;
  if (!token.refresh_token) return undefined;
  // Never send a saved refresh token to an unrelated host from a malformed config.
  if (!["https://auth.kimi.ai", "https://auth.kimi.com"].includes(host)) return undefined;
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.post(`${host}/api/oauth/token`).pipe(
        HttpClientRequest.bodyUrlParams({
          client_id: "17e5f671-d194-4dfb-9706-5516cb48c098",
          grant_type: "refresh_token",
          refresh_token: token.refresh_token,
        }),
      ),
    )
    .pipe(Effect.timeout("10 seconds"));
  const refreshed = yield* HttpClientResponse.schemaBodyJson(RefreshResponse)(
    yield* HttpClientResponse.filterStatusOk(response),
  );
  // Preserve extra CLI metadata and rotating refresh tokens, atomically.
  return yield* Effect.gen(function* () {
    const current = yield* fs.readFileString(filename);
    if (current !== original) return (yield* decodeCredential(current)).access_token;
    const temp = yield* fs.makeTempFileScoped({
      directory: path.dirname(filename),
      prefix: ".t3-kimi-",
    });
    yield* fs.chmod(temp, 0o600);
    const refreshedAt = DateTime.toEpochMillis(yield* DateTime.now) / 1000;
    yield* fs.writeFileString(
      temp,
      yield* encodeRecord({
        ...saved,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? token.refresh_token,
        expires_at: refreshedAt + refreshed.expires_in,
        expires_in: refreshed.expires_in,
      }),
    );
    // Recheck immediately before replacement in case the CLI refreshed while writing.
    const latest = yield* fs.readFileString(filename);
    if (latest !== original) return (yield* decodeCredential(latest)).access_token;
    yield* fs.rename(temp, filename);
    return refreshed.access_token;
  }).pipe(Effect.scoped, Effect.uninterruptible);
});

export const readKimiUsageLimits = Effect.fn("readKimiUsageLimits")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const now = yield* DateTime.now;
  const checkedAt = DateTime.formatIso(now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  const failed = (message: string) =>
    makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message });

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home =
      environment.KIMI_CODE_HOME?.trim() ||
      path.join(environment.HOME || environment.USERPROFILE || NodeOS.homedir(), ".kimi-code");
    const credentialsDir = path.join(home, "credentials");
    const config = yield* fs
      .readFileString(path.join(home, "config.toml"))
      .pipe(Effect.orElseSucceed(() => ""));
    const oauth = kimiOAuthFromConfig(config);
    const names = yield* fs
      .readDirectory(credentialsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const candidates = names.filter((name) => /^kimi-code[\w-]*\.json$/.test(name));
    const name = oauth.key
      ? `${oauth.key}.json`
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (!name) return unsupported;
    const filename = path.join(credentialsDir, name);
    const credential = yield* fs.readFileString(filename).pipe(Effect.flatMap(decodeCredential));
    // An API-key setup has no plan windows to report.
    if (!credential?.access_token) return unsupported;
    const nowSeconds = DateTime.toEpochMillis(now) / 1000;
    const baseUrl = (
      environment.KIMI_CODE_BASE_URL?.trim() ||
      kimiBaseUrlFromConfig(config) ||
      DEFAULT_BASE_URL
    ).replace(/\/+$/, "");
    const accessToken =
      (credential.expires_at ?? 0) >= nowSeconds + EXPIRY_MARGIN_SECONDS
        ? credential.access_token
        : yield* refreshCredential(
            filename,
            (
              oauth.host ??
              (baseUrl.includes("api.kimi.ai") ? "https://auth.kimi.ai" : "https://auth.kimi.com")
            ).replace(/\/+$/, ""),
            nowSeconds,
          ).pipe(refreshLock.withPermits(1));
    if (!accessToken) return failed("Kimi needs a fresh sign-in. Run kimi login.");
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${baseUrl}/usages`).pipe(HttpClientRequest.bearerToken(accessToken)),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(KimiUsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return kimiUsageResponseToLimits(body, checkedAt);
  }).pipe(
    Effect.timeout("20 seconds"),
    Effect.orElseSucceed(() => failed("Kimi could not read usage limits.")),
  );
});
