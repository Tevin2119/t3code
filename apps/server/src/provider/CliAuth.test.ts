import { ProviderInstanceId, ProviderSetupError, type ProviderAuthState } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeCliAuth, type CliAuthOptions } from "./CliAuth.ts";
import type { ProviderAuthController } from "./Services/ProviderAuthService.ts";

const INSTANCE_ID = ProviderInstanceId.make("pi");
const OWNER = "owner-session";

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

/**
 * A controller with no `login` must never start a process, so a spawner that
 * dies on use is both the requirement and the assertion.
 */
const noSpawner = {
  spawn: () => Effect.die("CliAuth must not spawn for a verify-only provider"),
} as unknown as ChildProcessSpawner.ChildProcessSpawner["Service"];

const runController = <A, E>(
  options: CliAuthOptions,
  body: (controller: ProviderAuthController) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  makeCliAuth(options).pipe(
    Effect.flatMap(body),
    Effect.scoped,
    Effect.provideService(Crypto.Crypto, testCrypto),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
  );

/** Resolve on the first phase matching `match` that the controller publishes. */
const awaitPhase = (
  controller: ProviderAuthController,
  ownerSessionId: string,
  match: (state: ProviderAuthState) => boolean,
) => Stream.runHead(Stream.filter(controller.subscribe(ownerSessionId), match));

const isSettled = (state: ProviderAuthState) =>
  state.phase === "succeeded" || state.phase === "failed" || state.phase === "cancelled";

const failureDetail = (exit: Exit.Exit<unknown, ProviderSetupError>): string => {
  assert(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert(Option.isSome(error));
  return error.value.detail;
};

const baseOptions: CliAuthOptions = {
  instanceId: INSTANCE_ID,
  providerName: "pi",
  verify: Effect.succeed(true),
  signInHint: "pi has no credentials for provider 'kimi-coding'.",
};

describe("CliAuth", () => {
  it.effect("settles on the live credential read, not on the CLI exiting cleanly", () =>
    Effect.gen(function* () {
      const settled = yield* runController(baseOptions, (controller) =>
        Effect.gen(function* () {
          const waiter = yield* awaitPhase(controller, OWNER, isSettled).pipe(Effect.forkChild);
          const started = yield* controller.start(OWNER);
          expect(started.phase).toBe("starting");
          return yield* Fiber.await(waiter);
        }),
      );

      assert(Exit.isSuccess(settled));
      assert(Option.isSome(settled.value));
      expect(settled.value.value.phase).toBe("succeeded");
    }),
  );

  it.effect("fails with the provider's own sign-in instructions when no credentials exist", () =>
    Effect.gen(function* () {
      const verifyCalls = yield* Ref.make(0);
      const settled = yield* runController(
        {
          ...baseOptions,
          verify: Ref.update(verifyCalls, (count) => count + 1).pipe(Effect.as(false)),
        },
        (controller) =>
          Effect.gen(function* () {
            const waiter = yield* awaitPhase(controller, OWNER, isSettled).pipe(Effect.forkChild);
            yield* controller.start(OWNER);
            const result = yield* Fiber.await(waiter);
            return { result, calls: yield* Ref.get(verifyCalls) };
          }),
      );

      assert(Exit.isSuccess(settled.result));
      assert(Option.isSome(settled.result.value));
      expect(settled.result.value.value.phase).toBe("failed");
      expect(settled.result.value.value.message).toBe(baseOptions.signInHint);
      expect(settled.calls).toBe(1);
    }),
  );

  it.effect("rejects a pasted redirect URL, which no CLI flow ever produces", () =>
    Effect.gen(function* () {
      const exit = yield* runController(baseOptions, (controller) =>
        Effect.exit(
          controller.complete(OWNER, { flowId: "flow-1", callbackUrl: "http://127.0.0.1/cb" }),
        ),
      );

      expect(failureDetail(exit)).toContain("no redirect URL to paste");
    }),
  );

  it.effect("refuses sign-out with the CLI's own instructions when it has no headless logout", () =>
    Effect.gen(function* () {
      const exit = yield* runController(
        { ...baseOptions, signOutHint: "pi can only sign out from its own TUI." },
        (controller) => Effect.exit(controller.logout(Effect.void)),
      );

      expect(failureDetail(exit)).toBe("pi can only sign out from its own TUI.");
    }),
  );

  it.effect("reports a failed sign-out with the reason, not as a success", () =>
    Effect.gen(function* () {
      const exit = yield* runController(
        {
          ...baseOptions,
          logout: () =>
            Effect.fail(
              new ProviderSetupError({
                instanceId: INSTANCE_ID,
                operation: "logout",
                detail: "This CLI version does not support sign-out.",
              }),
            ),
        },
        (controller) => Effect.exit(controller.logout(Effect.void)),
      );

      expect(failureDetail(exit)).toBe("This CLI version does not support sign-out.");
    }),
  );

  it.effect("stops the provider's sessions before clearing its credential", () =>
    Effect.gen(function* () {
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      const state = yield* runController(
        {
          ...baseOptions,
          logout: (stopSessions) =>
            stopSessions.pipe(Effect.andThen(Ref.update(order, (steps) => [...steps, "cleared"]))),
          onSettled: Ref.update(order, (steps) => [...steps, "refreshed"]),
        },
        (controller) =>
          controller.logout(Ref.update(order, (steps) => [...steps, "stopped"])).pipe(
            Effect.map((published) => ({ published, steps: undefined })),
            Effect.flatMap((result) =>
              Ref.get(order).pipe(Effect.map((steps) => ({ ...result, steps }))),
            ),
          ),
      );

      expect(state.steps).toEqual(["stopped", "cleared", "refreshed"]);
      expect(state.published.phase).toBe("idle");
      expect(state.published.message).toBe("Signed out of pi.");
    }),
  );

  it.effect("hides another client's flow while still showing that setup is busy", () =>
    Effect.gen(function* () {
      const observed = yield* runController(
        { ...baseOptions, verify: Effect.never },
        (controller) =>
          Effect.gen(function* () {
            const waiter = yield* awaitPhase(
              controller,
              "other-session",
              (state) => state.phase !== "idle",
            ).pipe(Effect.forkChild);
            yield* controller.start(OWNER);
            return yield* Fiber.await(waiter);
          }),
      );

      assert(Exit.isSuccess(observed));
      assert(Option.isSome(observed.value));
      expect(observed.value.value.flowId).toBeNull();
      expect(observed.value.value.message).toBe("Sign-in is in progress in another client.");
    }),
  );
});
