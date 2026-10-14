// @effect-diagnostics nodeBuiltinImport:off - joins paths inside a scoped temp directory.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import { readKimiUsageLimits } from "./kimiUsageLimits.ts";

const decode = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const original =
  '{"access_token":"expired","refresh_token":"refresh-old","expires_at":10,"scope":"retained"}';
const config =
  '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.ai/coding/v1"\n[providers."managed:kimi-code".oauth]\nkey = "oauth/kimi-code-test"\noauth_host = "https://auth.kimi.ai"\n';
const usage = { usages: { limit_5h: { used_ratio: 0.25 } } };

const setup = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(NodePath.join(directory, "credentials"));
  const filename = NodePath.join(directory, "credentials", "kimi-code-test.json");
  yield* fs.writeFileString(filename, original);
  yield* fs.writeFileString(NodePath.join(directory, "config.toml"), config);
  return { fs, directory, filename };
});

it.layer(NodeServices.layer)("Kimi usage refresh", (it) => {
  it.effect("rotates an expired token and preserves CLI metadata without a chat", () =>
    Effect.gen(function* () {
      const { fs, directory, filename } = yield* setup();
      const calls: string[] = [];
      const client = HttpClient.make((request) => {
        calls.push(request.url);
        if (request.method === "POST") {
          expect(request.url).toBe("https://auth.kimi.ai/api/oauth/token");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ access_token: "fresh", refresh_token: "rotated", expires_in: 900 }),
            ),
          );
        }
        expect(request.headers.authorization).toBe("Bearer fresh");
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(usage)));
      });
      const limits = yield* readKimiUsageLimits({ KIMI_CODE_HOME: directory }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(limits.windows[0]?.usedPercent).toBe(25);
      expect(calls).toHaveLength(2);
      expect(yield* fs.readFileString(filename).pipe(Effect.flatMap(decode))).toMatchObject({
        access_token: "fresh",
        refresh_token: "rotated",
        scope: "retained",
        expires_at: 900,
      });
      expect(yield* fs.readDirectory(NodePath.join(directory, "credentials"))).toEqual([
        "kimi-code-test.json",
      ]);
      // The persisted token must be reused on the next poll.
      yield* readKimiUsageLimits({ KIMI_CODE_HOME: directory }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(calls).toHaveLength(3);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps credentials intact on refresh rejection and never exposes the response body",
    () =>
      Effect.gen(function* () {
        const { fs, directory, filename } = yield* setup();
        const limits = yield* readKimiUsageLimits({ KIMI_CODE_HOME: directory }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response("secret-provider-error", { status: 401 }),
                ),
              ),
            ),
          ),
        );
        expect(limits.unavailable?.reason).toBe("probeFailed");
        expect(limits.unavailable?.message).not.toContain("secret-provider-error");
        expect(yield* fs.readFileString(filename)).toBe(original);
      }).pipe(Effect.scoped),
  );

  it.effect("preserves a credential updated by the CLI during refresh", () =>
    Effect.gen(function* () {
      const { fs, directory, filename } = yield* setup();
      const replacement =
        '{"access_token":"cli-fresh","refresh_token":"cli-rotated","expires_at":1000}';
      const limits = yield* readKimiUsageLimits({ KIMI_CODE_HOME: directory }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              if (request.method === "POST") {
                yield* fs.writeFileString(filename, replacement).pipe(Effect.orDie);
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    access_token: "ours",
                    refresh_token: "ours-rotated",
                    expires_in: 900,
                  }),
                );
              }
              expect(request.headers.authorization).toBe("Bearer cli-fresh");
              return HttpClientResponse.fromWeb(request, Response.json(usage));
            }),
          ),
        ),
      );
      expect(limits.windows).toHaveLength(1);
      expect(yield* fs.readFileString(filename)).toBe(replacement);
    }).pipe(Effect.scoped),
  );

  it.effect("selects the configured account even when another region has a newer token", () =>
    Effect.gen(function* () {
      const { fs, directory, filename } = yield* setup();
      yield* fs.writeFileString(filename, '{"access_token":"selected","expires_at":1000}');
      yield* fs.writeFileString(
        NodePath.join(directory, "credentials", "kimi-code-other.json"),
        '{"access_token":"wrong-region","expires_at":9000}',
      );
      const limits = yield* readKimiUsageLimits({ KIMI_CODE_HOME: directory }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.headers.authorization).toBe("Bearer selected");
            return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(usage)));
          }),
        ),
      );
      expect(limits.windows).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not send refresh tokens to an unrecognized auth host", () =>
    Effect.gen(function* () {
      const { fs, directory, filename } = yield* setup();
      yield* fs.writeFileString(
        NodePath.join(directory, "config.toml"),
        config.replace("https://auth.kimi.ai", "https://unrelated.test"),
      );
      const limits = yield* readKimiUsageLimits({ KIMI_CODE_HOME: directory }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("must not send credentials")),
        ),
      );
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(yield* fs.readFileString(filename)).toBe(original);
    }).pipe(Effect.scoped),
  );
});
