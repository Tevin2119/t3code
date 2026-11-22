import {
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { deliveryBindingAtom } from "../deliveryModelLock.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { scopeThreadRef } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createDeliveryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    /** A thread as the client holds it, so its limited-seat notices follow its runs. */
    readonly threadShellAtom?: (
      ref: ScopedThreadRef,
    ) => Atom.Atom<Pick<EnvironmentThreadShell, "latestRun" | "runtime"> | null>;
  } = {},
) {
  const { threadShellAtom } = options;
  // Only what can change a limit: the latest run, how it ended, and the reset it reported.
  const limitedSeatsRevision = Atom.family((key: string) =>
    Atom.make((get) => {
      if (threadShellAtom === undefined) return "";
      const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
      const shell = get(threadShellAtom(scopeThreadRef(environmentId, threadId)));
      return `${shell?.latestRun?.runId ?? ""}:${shell?.latestRun?.status ?? ""}:${shell?.runtime?.usageLimitResetAt ?? ""}`;
    }),
  );
  const threadBinding = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:delivery:thread-binding",
    tag: WS_METHODS.deliveryThreadBinding,
    staleTimeMs: 1_000,
  });
  const modelBinding = Atom.family((query: ReturnType<typeof threadBinding>) =>
    Atom.family((threadId: string) => deliveryBindingAtom(query, threadId)),
  );
  return {
    /** Engine state changes while a team works, so a reading goes stale quickly. */
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:read",
      tag: WS_METHODS.deliveryRead,
      staleTimeMs: 2_000,
    }),
    /** A thread's team, or the team choice that is still held. Cheap, and read often. */
    threadBinding,
    /** Query families include the environment and thread; previous query values never carry over. */
    modelBinding: (target: Parameters<typeof threadBinding>[0]) =>
      modelBinding(threadBinding(target))(target.input.threadId),
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
    setThreadLineup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:set-thread-lineup",
      tag: WS_METHODS.deliverySetThreadLineup,
      // A conversation's roster changes one at a time, in the order they were made.
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
    }),
    /** Which seats of a conversation are limited now, and what could stand in. */
    limitedSeats: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:limited-seats",
      tag: WS_METHODS.deliveryLimitedSeats,
      staleTimeMs: 2_000,
      refreshTrigger: ({ environmentId, input }) =>
        limitedSeatsRevision(JSON.stringify([environmentId, input.threadId])),
    }),
    /** One click of a limited-seat notice. A second click while the first runs joins it. */
    swapLimitedSeat: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:swap-limited-seat",
      tag: WS_METHODS.deliverySwapLimitedSeat,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.seat]),
      },
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
