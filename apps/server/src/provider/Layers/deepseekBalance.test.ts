// @effect-diagnostics nodeBuiltinImport:off - joins paths inside a scoped temp directory.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  apiKeyFromDotenv,
  deepseekBalanceFromResponse,
  readDeepSeekBalance,
} from "./deepseekBalance.ts";

/** Shaped after DeepSeek's documented `GET /user/balance` answer. */
const BALANCE = {
  is_available: true,
  balance_infos: [
    {
      currency: "USD",
      total_balance: "12.34",
      granted_balance: "0.00",
      topped_up_balance: "12.34",
    },
  ],
};

describe("deepseekBalanceFromResponse", () => {
  it("keeps the currency and the amounts as DeepSeek wrote them", () => {
    expect(deepseekBalanceFromResponse(BALANCE)).toEqual({
      status: "read",
      sufficient: true,
      amounts: [{ currency: "USD", total: "12.34", granted: "0.00", toppedUp: "12.34" }],
    });
  });

  it("says so when there is no balance, or the answer cannot be read", () => {
    expect(deepseekBalanceFromResponse({ is_available: false, balance_infos: [] })).toMatchObject({
      status: "read",
      sufficient: false,
      message: "DeepSeek reported no balance.",
    });
    expect(deepseekBalanceFromResponse({ balance_infos: "nope" }).status).toBe("failed");
  });

  it("reads a plain key from a dotenv file", () => {
    expect(apiKeyFromDotenv('export DEEPSEEK_API_KEY="sk-test"\n')).toBe("sk-test");
    expect(apiKeyFromDotenv("OTHER=1\n")).toBeUndefined();
  });
});

/** Whether the key appears anywhere in a value the reader returned. */
const holdsKey = (value: unknown): boolean =>
  typeof value === "string"
    ? value.includes("sk-test")
    : typeof value === "object" && value !== null && Object.values(value).some(holdsKey);

const sealedCredentials =
  "version: 1\nrecords:\n  rec-1:\n    kind: grant\nrefs:\n  DEEPSEEK_API_KEY: rec-1\n";

it.layer(NodeServices.layer)("readDeepSeekBalance", (it) => {
  it.effect("asks DeepSeek with the key as a bearer header, and returns no key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const seen: string[] = [];
      const client = HttpClient.make((request) => {
        seen.push(`${request.method} ${request.url} ${request.headers.authorization}`);
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(BALANCE)));
      });
      const limits = yield* readDeepSeekBalance({
        DSH_HOME: home,
        DEEPSEEK_API_KEY: "sk-test",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(seen).toEqual(["GET https://api.deepseek.com/user/balance Bearer sk-test"]);
      expect(limits.windows).toEqual([]);
      expect(limits.balance?.amounts[0]?.total).toBe("12.34");
      expect(holdsKey(limits)).toBe(false);
    }),
  );

  it.effect("does not open a sealed key, and says how to show the balance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(NodePath.join(home, ".credentials.yaml"), sealedCredentials);
      const client = HttpClient.make(() => Effect.die("no request is made"));
      const limits = yield* readDeepSeekBalance({ DSH_HOME: home }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(limits.balance?.status).toBe("unavailable");
      expect(limits.balance?.message).toMatch(/sealed/);
    }),
  );

  it.effect("sends no key to an endpoint that is not DeepSeek's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const client = HttpClient.make(() => Effect.die("no request is made"));
      const limits = yield* readDeepSeekBalance({
        DSH_HOME: home,
        DEEPSEEK_API_KEY: "sk-test",
        DEEPSEEK_BASE_URL: "http://127.0.0.1:9999/v1",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(limits.balance?.status).toBe("unavailable");
    }),
  );

  it.effect("reports a refused key and an outage without the key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const answer = (status: number) =>
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status }))),
        );
      const refused = yield* readDeepSeekBalance({
        DSH_HOME: home,
        DEEPSEEK_API_KEY: "sk-test",
      }).pipe(Effect.provideService(HttpClient.HttpClient, answer(401)));
      expect(refused.balance).toMatchObject({
        status: "failed",
        message: "DeepSeek refused the key for the balance.",
      });
      const down = yield* readDeepSeekBalance({ DSH_HOME: home, DEEPSEEK_API_KEY: "sk-test" }).pipe(
        Effect.provideService(HttpClient.HttpClient, answer(503)),
      );
      expect(down.balance?.message).toBe("DeepSeek did not answer the balance (HTTP 503).");
      expect(holdsKey([refused, down])).toBe(false);
    }),
  );
});
