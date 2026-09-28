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
    /** A thread's team, or the team choice that is still held. Cheap, and read often. */
    threadBinding: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:thread-binding",
      tag: WS_METHODS.deliveryThreadBinding,
      staleTimeMs: 1_000,
    }),
    /** One reading asked for by hand, such as a piece of a file. Not kept and not refreshed. */
    fetch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:fetch",
      tag: WS_METHODS.deliveryRead,
    }),
    act: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:act",
      tag: WS_METHODS.deliveryAct,
    }),
    /** Gives up a team choice whose setup never completed. */
    releaseThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:release-thread",
      tag: WS_METHODS.deliveryReleaseThread,
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
