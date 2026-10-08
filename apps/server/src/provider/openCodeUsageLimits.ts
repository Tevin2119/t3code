import * as NodeOS from "node:os";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "./providerUsageLimits.ts";
import { fetchZaiUsageLimits, ZAI_ORIGIN, ZHIPU_ORIGIN } from "./zaiUsageLimits.ts";

const AuthFile = Schema.Struct({
  "opencode-go": Schema.optionalKey(Schema.Unknown),
  "zai-coding-plan": Schema.optionalKey(Schema.Unknown),
  "zhipuai-coding-plan": Schema.optionalKey(Schema.Unknown),
});
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);
const UsageWindow = Schema.Struct({
  percent: Schema.Finite,
  resetsAt: Schema.DateTimeUtcFromString,
});
const UsageResponse = Schema.Struct({
  usage: Schema.Struct({ rolling: UsageWindow, weekly: UsageWindow, monthly: UsageWindow }),
});

const readAuthFile = Effect.fn("readOpenCodeAuthFile")(function* (env: NodeJS.ProcessEnv) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dataHome =
    env.XDG_DATA_HOME ||
    path.join(env.HOME || env.USERPROFILE || NodeOS.homedir(), ".local", "share");
  const contents =
    env.OPENCODE_AUTH_CONTENT ||
    (yield* fs.readFileString(path.join(dataHome, "opencode", "auth.json")).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
      }),
    ));
  return yield* decodeAuthFile(contents);
});

/** Windows of every plan that reported; a failed plan only shows when none did. */
export function mergeOpenCodeUsageLimits(
  checkedAt: string,
  plans: ReadonlyArray<ServerProviderUsageLimits>,
): ServerProviderUsageLimits {
  const windows = plans.flatMap((plan) => plan.windows);
  if (windows.length > 0) {
    const reported = plans.filter((plan) => plan.windows.length > 0);
    return {
      ...makeUsageLimits({ checkedAt, windows }),
      // A combined Go + GLM report is not one subscription and cannot be merged.
      ...(reported.length === 1 && reported[0]?.quotaGroup
        ? { quotaGroup: reported[0].quotaGroup }
        : {}),
    };
  }
  return (
    plans.find((plan) => plan.unavailable?.reason === "probeFailed") ??
    makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" })
  );
}

/** The Z.AI (GLM) coding plan, when OpenCode holds a key for it. */
export const readOpenCodeZaiUsageLimits = Effect.fn("readOpenCodeZaiUsageLimits")(
  function* (input: {
    readonly enabled: boolean;
    readonly serverUrl: string;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    if (!input.enabled || input.serverUrl.trim()) return unsupported;

    return yield* Effect.gen(function* () {
      const auth = yield* readAuthFile(input.environment);
      const international = decodeApiAuth(auth["zai-coding-plan"]);
      const mainland = decodeApiAuth(auth["zhipuai-coding-plan"]);
      const credential = Option.isSome(international)
        ? { apiKey: international.value.key.trim(), origin: ZAI_ORIGIN }
        : Option.isSome(mainland)
          ? { apiKey: mainland.value.key.trim(), origin: ZHIPU_ORIGIN }
          : undefined;
      if (!credential?.apiKey) return unsupported;
      return yield* fetchZaiUsageLimits({ ...credential, checkedAt, labelPrefix: "GLM · " });
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() =>
        makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "OpenCode could not read GLM plan usage.",
        }),
      ),
    );
  },
);

/** External OpenCode servers own their credentials; never read the host's account for them. */
export const readOpenCodeGoUsageLimits = Effect.fn("readOpenCodeGoUsageLimits")(function* (input: {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (!input.enabled || input.serverUrl.trim()) return unsupported;

  return yield* Effect.gen(function* () {
    const env = input.environment;
    const auth = yield* readAuthFile(env);
    const apiAuth = decodeApiAuth(auth["opencode-go"]);
    // OpenCode overlays stored API credentials after environment credentials.
    const apiKey = (Option.isSome(apiAuth) ? apiAuth.value.key : env.OPENCODE_API_KEY)?.trim();
    if (!apiKey) return unsupported;

    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
        HttpClientRequest.bearerToken(apiKey),
      ),
    );
    // A valid Zen key can exist without a Go subscription.
    if (response.status === 403) return unsupported;
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
    );
    const windows: ServerProviderUsageWindow[] = [
      {
        id: "go_rolling",
        kind: "session",
        label: "Go · Session",
        windowDurationMins: 5 * 60,
        usedPercent: clampPercent(body.usage.rolling.percent),
        resetsAt: DateTime.formatIso(body.usage.rolling.resetsAt),
      },
      {
        id: "go_weekly",
        kind: "weekly",
        label: "Go · Weekly",
        windowDurationMins: 7 * 24 * 60,
        usedPercent: clampPercent(body.usage.weekly.percent),
        resetsAt: DateTime.formatIso(body.usage.weekly.resetsAt),
      },
      {
        id: "go_monthly",
        kind: "monthly",
        label: "Go · Monthly",
        usedPercent: clampPercent(body.usage.monthly.percent),
        resetsAt: DateTime.formatIso(body.usage.monthly.resetsAt),
      },
    ];
    return makeUsageLimits({ checkedAt, windows });
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "OpenCode Go could not read usage.",
      }),
    ),
  );
});
