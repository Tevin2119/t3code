import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { CHECKOUT_SUPERVISOR_ENV, type ServerMessage } from "./protocol.ts";

// Apart from CheckoutUpdate.ts so the environment can ask whether it is supervised without
// importing the server's startup, which would close an import cycle through the orchestrator.

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

/** True when this process was started by the checkout supervisor with its channel open. */
export const isCheckoutSupervised = Effect.gen(function* () {
  const environment = yield* HostProcess.Environment;
  const channel = yield* CheckoutUpdateHostChannel;
  return environment[CHECKOUT_SUPERVISOR_ENV] === "1" && channel.connected();
});
