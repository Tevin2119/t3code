// Read only plaintext harness credentials; sealed grants remain private to the harness.
// Send the key only to DeepSeek, never to logs or returned data.
import * as NodeOS from "node:os";

import type { ServerProviderBalance, ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { credentialFileHoldsApiKey } from "./DeepSeekProvider.ts";

const API_KEY_NAME = "DEEPSEEK_API_KEY";
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const OFFICIAL_HOSTS = new Set(["api.deepseek.com"]);

const BalanceInfo = Schema.Struct({
  currency: Schema.optional(Schema.String),
  total_balance: Schema.optional(Schema.String),
  granted_balance: Schema.optional(Schema.String),
  topped_up_balance: Schema.optional(Schema.String),
});
export const DeepSeekBalanceResponse = Schema.Struct({
  is_available: Schema.optional(Schema.Boolean),
  balance_infos: Schema.optional(Schema.Array(BalanceInfo)),
});
const decodeResponse = Schema.decodeUnknownOption(DeepSeekBalanceResponse);

const text = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** The balance as DeepSeek answered it; amounts stay the decimal strings it sent. */
export function deepseekBalanceFromResponse(body: unknown): ServerProviderBalance {
  const decoded = decodeResponse(body);
  if (decoded._tag === "None") {
    return {
      status: "failed",
      message: "DeepSeek answered in a form T3 does not read.",
      amounts: [],
    };
  }
  const amounts = (decoded.value.balance_infos ?? []).flatMap((info) => {
    const currency = text(info.currency);
    const total = text(info.total_balance);
    if (!currency || !total) return [];
    const granted = text(info.granted_balance);
    const toppedUp = text(info.topped_up_balance);
    return [
      { currency, total, ...(granted ? { granted } : {}), ...(toppedUp ? { toppedUp } : {}) },
    ];
  });
  return {
    status: "read",
    ...(decoded.value.is_available === undefined ? {} : { sufficient: decoded.value.is_available }),
    amounts,
    ...(amounts.length === 0 ? { message: "DeepSeek reported no balance." } : {}),
  };
}

/** A plain key from a dotenv file, or undefined. */
export function apiKeyFromDotenv(contents: string): string | undefined {
  const value = new RegExp(`^\\s*(?:export\\s+)?${API_KEY_NAME}\\s*=\\s*(.*?)\\s*$`, "m").exec(
    contents,
  )?.[1];
  return text(value?.replace(/^(["'])(.*)\1$/, "$2"));
}

const limitsWith = (
  checkedAt: string,
  balance: ServerProviderBalance,
): ServerProviderUsageLimits => ({
  checkedAt,
  windows: [],
  balance,
});

export const readDeepSeekBalance = Effect.fn("readDeepSeekBalance")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unavailable = (message: string) =>
    limitsWith(checkedAt, { status: "unavailable", message, amounts: [] });

  // A harness pointed at another endpoint is not using DeepSeek's account.
  const baseUrl = text(environment.DEEPSEEK_BASE_URL);
  if (baseUrl) {
    const host = yield* Effect.try(() => new URL(baseUrl).hostname.toLowerCase()).pipe(
      Effect.orElseSucceed(() => ""),
    );
    if (!OFFICIAL_HOSTS.has(host)) {
      return unavailable(
        "The DeepSeek Harness points at another endpoint, which has no DeepSeek balance.",
      );
    }
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home =
    text(environment.DSH_HOME) ??
    path.join(environment.HOME || environment.USERPROFILE || NodeOS.homedir(), ".dsh");
  const read = (name: string) =>
    fs.readFileString(path.join(home, name)).pipe(Effect.orElseSucceed(() => ""));
  const key = text(environment[API_KEY_NAME]) ?? apiKeyFromDotenv(yield* read(".env"));
  if (!key) {
    return unavailable(
      credentialFileHoldsApiKey(yield* read(".credentials.yaml"))
        ? "The key is sealed in the DeepSeek Harness's own credential store, which T3 does not open. To show the balance, add DEEPSEEK_API_KEY to the DeepSeek connection's environment in Settings."
        : "The DeepSeek Harness has no API key.",
    );
  }

  const client = yield* HttpClient.HttpClient;
  return yield* client
    .execute(HttpClientRequest.get(BALANCE_URL).pipe(HttpClientRequest.bearerToken(key)))
    .pipe(
      Effect.flatMap((response) =>
        response.status === 401 || response.status === 403
          ? Effect.succeed(
              limitsWith(checkedAt, {
                status: "failed",
                message: "DeepSeek refused the key for the balance.",
                amounts: [],
              }),
            )
          : response.status < 200 || response.status >= 300
            ? Effect.succeed(
                limitsWith(checkedAt, {
                  status: "failed",
                  message: `DeepSeek did not answer the balance (HTTP ${response.status}).`,
                  amounts: [],
                }),
              )
            : response.json.pipe(
                Effect.map((body) => limitsWith(checkedAt, deepseekBalanceFromResponse(body))),
              ),
      ),
      Effect.timeout("15 seconds"),
      Effect.orElseSucceed(() =>
        limitsWith(checkedAt, {
          status: "failed",
          message: "DeepSeek could not be reached for the balance.",
          amounts: [],
        }),
      ),
    );
});
