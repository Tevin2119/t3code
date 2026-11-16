/**
 * CheckoutUpdate - lets a client update a server that runs from a git checkout.
 *
 * The checkout supervisor (`apps/server/scripts/checkout-supervisor.ts`) owns
 * the work: it follows a branch, builds the newer commit beside the running
 * one, and swaps the server for it. This service is the server's end of the
 * supervisor's IPC channel. It relays the supervisor's state to clients and
 * their requests to the supervisor. Before acknowledging replacement, it stops
 * the effect worker and providers and persists continuation recovery.
 *
 * Without the supervisor every request fails: such a server is updated by hand.
 *
 * @module CheckoutUpdate
 */
import { CheckoutUpdateError, CheckoutUpdateState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import { CheckoutUpdateHostChannel, isCheckoutSupervised } from "./hostChannel.ts";
import { isSupervisorMessage, type ServerMessage, type SupervisorMessage } from "./protocol.ts";

export { CheckoutUpdateHostChannel, type CheckoutUpdateChannel } from "./hostChannel.ts";

export class CheckoutUpdate extends Context.Service<
  CheckoutUpdate,
  {
    /** The supervisor's state, the latest first, then each change. */
    readonly states: Stream.Stream<CheckoutUpdateState, CheckoutUpdateError>;
    /** Asks the supervisor to look for a newer commit now. */
    readonly check: Effect.Effect<void, CheckoutUpdateError>;
    /** Asks the supervisor to build the newer commit and restart into it. */
    readonly start: Effect.Effect<void, CheckoutUpdateError>;
  }
>()("t3/checkoutUpdate/CheckoutUpdate") {}

const decodeState = Schema.decodeUnknownOption(CheckoutUpdateState);

const notSupervised = new CheckoutUpdateError({
  reason: "This server is not run by the checkout supervisor, so it is updated by hand.",
});

export const make = Effect.gen(function* () {
  if (!(yield* isCheckoutSupervised)) {
    return CheckoutUpdate.of({
      states: Stream.fail(notSupervised),
      check: Effect.fail(notSupervised),
      start: Effect.fail(notSupervised),
    });
  }
  const channel = yield* CheckoutUpdateHostChannel;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const state = yield* SubscriptionRef.make(Option.none<CheckoutUpdateState>());
  const inbox = yield* Queue.unbounded<SupervisorMessage>();
  const stopListening = channel.listen((message) => {
    if (isSupervisorMessage(message)) Queue.offerUnsafe(inbox, message);
  });
  yield* Effect.addFinalizer(() => Effect.sync(stopListening));

  const handle = (message: SupervisorMessage) =>
    message.type === "t3-checkout.state"
      ? Option.match(decodeState(message.state), {
          onNone: () =>
            Effect.logWarning("checkout supervisor sent a state this server cannot read"),
          onSome: (next) => SubscriptionRef.set(state, Option.some(next)),
        })
      : startup.prepareForRestart.pipe(
          Effect.andThen(
            Effect.sync(() => channel.send({ type: "t3-checkout.prepared", threads: 0 })),
          ),
          Effect.catchCause(() =>
            Effect.logWarning(
              "The server could not confirm safe restart preparation. No replacement was authorized.",
            ).pipe(
              Effect.andThen(
                Effect.sync(() => channel.send({ type: "t3-checkout.preparation-failed" })),
              ),
            ),
          ),
        );
  yield* Queue.take(inbox).pipe(Effect.flatMap(handle), Effect.forever, Effect.forkScoped);

  // The supervisor waits for this to know the server took over.
  yield* startup.awaitCommandReady.pipe(
    Effect.andThen(Effect.sync(() => channel.send({ type: "t3-checkout.ready" }))),
    Effect.ignoreCause,
    Effect.forkScoped,
  );

  const ask = (message: ServerMessage) =>
    Effect.suspend(() =>
      channel.connected()
        ? Effect.sync(() => channel.send(message))
        : Effect.fail(new CheckoutUpdateError({ reason: "The checkout supervisor is gone." })),
    );

  return CheckoutUpdate.of({
    states: SubscriptionRef.changes(state).pipe(
      Stream.flatMap((value) => (Option.isSome(value) ? Stream.make(value.value) : Stream.empty)),
    ),
    check: ask({ type: "t3-checkout.check" }),
    start: ask({ type: "t3-checkout.update" }),
  });
});

export const layer = Layer.effect(CheckoutUpdate, make);
