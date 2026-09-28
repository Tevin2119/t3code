import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createDeliveryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Engine state changes while a team works, so a reading goes stale quickly. */
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:read",
      tag: WS_METHODS.deliveryRead,
      staleTimeMs: 2_000,
    }),
    /** A binding never changes once made, so it is only refetched after a bind. */
    threadBinding: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:thread-binding",
      tag: WS_METHODS.deliveryThreadBinding,
      staleTimeMs: 60_000,
    }),
    act: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:act",
      tag: WS_METHODS.deliveryAct,
    }),
    bindThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:bind-thread",
      tag: WS_METHODS.deliveryBindThread,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
    }),
  };
}
