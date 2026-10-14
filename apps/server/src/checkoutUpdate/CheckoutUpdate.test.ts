import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as CheckoutUpdate from "./CheckoutUpdate.ts";
import type { CheckoutUpdateSnapshot, ServerMessage } from "./protocol.ts";

const STATE: CheckoutUpdateSnapshot = {
  running: { commit: "a".repeat(40), subject: "Older work" },
  available: { commit: "b".repeat(40), subject: "Newer work", behind: 2 },
  phase: "idle",
  message: null,
  checkedAt: "2026-10-07T20:00:00.000Z",
  lastOutcome: null,
};

/** A supervisor's end of the channel, driven by the test. */
function fakeChannel(connected = true) {
  const sent: ServerMessage[] = [];
  const listeners = new Set<(message: unknown) => void>();
  const prepared = Deferred.makeUnsafe<number>();
  const preparationFailed = Deferred.makeUnsafe<void>();
  return {
    sent,
    prepared,
    preparationFailed,
    deliver: (message: unknown) => listeners.forEach((listener) => listener(message)),
    channel: {
      connected: () => connected,
      send: (message: ServerMessage) => {
        sent.push(message);
        if (message.type === "t3-checkout.prepared")
          Deferred.doneUnsafe(prepared, Exit.succeed(message.threads));
        if (message.type === "t3-checkout.preparation-failed")
          Deferred.doneUnsafe(preparationFailed, Exit.succeed(undefined));
      },
      listen: (listener: (message: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } satisfies CheckoutUpdate.CheckoutUpdateChannel,
  };
}

const startup = ServerRuntimeStartup.ServerRuntimeStartup.of({
  awaitCommandReady: Effect.void,
  markHttpListening: Effect.void,
  prepareForRestart: Effect.void,
  enqueueCommand: (effect) => effect,
});

const provide =
  (channel: CheckoutUpdate.CheckoutUpdateChannel, supervised = true, startupService = startup) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(CheckoutUpdate.CheckoutUpdateHostChannel, channel),
      Effect.provideService(ServerRuntimeStartup.ServerRuntimeStartup, startupService),
      Effect.provideService(
        HostProcess.Environment,
        supervised ? { T3CODE_CHECKOUT_SUPERVISOR: "1" } : {},
      ),
    );

describe("CheckoutUpdate", () => {
  it.effect("relays the supervisor's state, and says it took over once ready", () => {
    const fake = fakeChannel();
    return Effect.gen(function* () {
      const service = yield* CheckoutUpdate.make;
      const first = yield* service.states.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;
      fake.deliver({ type: "t3-checkout.state", state: STATE });
      const [state] = yield* Fiber.join(first);
      assert.deepStrictEqual(state, STATE);
      assert.deepInclude(fake.sent, { type: "t3-checkout.ready" });
      yield* service.start;
      assert.deepInclude(fake.sent, { type: "t3-checkout.update" });
    }).pipe(provide(fake.channel), Effect.scoped);
  });

  it.effect("prepares V2 runtime recovery before acknowledging the supervisor", () => {
    const fake = fakeChannel();
    const started = Deferred.makeUnsafe<void>();
    const released = Deferred.makeUnsafe<void>();
    const blockedStartup = {
      ...startup,
      prepareForRestart: Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(released)),
      ),
    };
    return Effect.gen(function* () {
      yield* CheckoutUpdate.make;
      fake.deliver({ type: "t3-checkout.prepare" });
      yield* Deferred.await(started);
      assert.isFalse(yield* Deferred.isDone(fake.prepared));
      yield* Deferred.succeed(released, undefined);
      assert.strictEqual(yield* Deferred.await(fake.prepared), 0);
    }).pipe(provide(fake.channel, true, blockedStartup), Effect.scoped);
  });

  it.effect(
    "failed restart preparation reports failure without authorizing replacement or exposing diagnostics",
    () => {
      const fake = fakeChannel();
      return Effect.gen(function* () {
        yield* CheckoutUpdate.make;
        fake.deliver({ type: "t3-checkout.prepare" });
        yield* Deferred.await(fake.preparationFailed);
        assert.isFalse(yield* Deferred.isDone(fake.prepared));
        assert.isFalse(JSON.stringify(fake.sent).includes("private-native-diagnostics"));
      }).pipe(
        provide(fake.channel, true, {
          ...startup,
          prepareForRestart: Effect.die("private-native-diagnostics"),
        }),
        Effect.scoped,
      );
    },
  );

  it.effect("refuses requests on a server the supervisor does not run", () => {
    const fake = fakeChannel();
    return Effect.gen(function* () {
      const service = yield* CheckoutUpdate.make;
      const result = yield* Effect.exit(service.start);
      assert.isTrue(Exit.isFailure(result));
      assert.deepStrictEqual(fake.sent, []);
    }).pipe(provide(fake.channel, false), Effect.scoped);
  });
});
