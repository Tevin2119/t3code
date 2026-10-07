/**
 * CheckoutUpdate - lets a client update a server that runs from a git checkout.
 *
 * The checkout supervisor (`apps/server/scripts/checkout-supervisor.ts`) owns
 * the work: it follows a branch, builds the newer commit beside the running
 * one, and swaps the server for it. This service is the server's end of the
 * supervisor's IPC channel. It relays the supervisor's state to clients and
 * their requests to the supervisor. Before the supervisor stops it, it marks
 * the running turns to continue in the replacement.
 *
 * Without the supervisor every request fails: such a server is updated by hand.
 *
 * @module CheckoutUpdate
 */
import { CheckoutUpdateError, CheckoutUpdateState } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import {
  CHECKOUT_SUPERVISOR_ENV,
  isSupervisorMessage,
  type ServerMessage,
  type SupervisorMessage,
} from "./protocol.ts";

/** The supervisor's channel: this process's own IPC channel. */
export interface CheckoutUpdateChannel {
  readonly connected: () => boolean;
  readonly send: (message: ServerMessage) => void;
  readonly listen: (listener: (message: unknown) => void) => () => void;
}

export const CheckoutUpdateHostChannel = Context.Reference<CheckoutUpdateChannel>(
  "t3/checkoutUpdate/hostChannel",
  {
    defaultValue: () => ({
      connected: () => process.connected && process.send !== undefined,
      send: (message) => {
        if (process.connected) process.send?.(message);
      },
      listen: (listener) => {
        process.on("message", listener);
        return () => process.off("message", listener);
      },
    }),
  },
);

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

/** True when this process was started by the checkout supervisor with its channel open. */
export const isCheckoutSupervised = Effect.gen(function* () {
  const environment = yield* HostProcessEnvironment;
  const channel = yield* CheckoutUpdateHostChannel;
  return environment[CHECKOUT_SUPERVISOR_ENV] === "1" && channel.connected();
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
      : // Marking can fail; the supervisor stops the server either way, so it is always answered.
        startup.markRunningProviderSessionsForContinuation.pipe(
          Effect.map((threads) => threads.length),
          Effect.catchCause((cause) =>
            Effect.logWarning("could not mark running turns before the update", { cause }).pipe(
              Effect.as(0),
            ),
          ),
          Effect.flatMap((threads) =>
            Effect.sync(() => channel.send({ type: "t3-checkout.prepared", threads })),
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
