import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  WS_METHODS,
  type DeliveryActInput,
  type DeliveryReadInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { EnvironmentNotRegisteredError, EnvironmentRegistry } from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createDeliveryEnvironmentAtoms } from "./delivery.ts";

const MAC = EnvironmentId.make("mac");
const WINDOWS = EnvironmentId.make("windows");
const TASK_PATH = "/api/tasks/1016";

const makeHarness = Effect.fn("TestDeliveryEnvironments.makeHarness")(function* () {
  const calls: Array<{ environmentId: EnvironmentId; method: string; input: unknown }> = [];
  const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
  for (const environmentId of [MAC, WINDOWS]) {
    const respond = (method: string, input: unknown) =>
      Effect.sync(() => {
        calls.push({ environmentId, method, input });
        return { readAt: "2026-10-05T00:00:00.000Z", body: { environmentId, task: "1016" } };
      });
    const client = {
      [WS_METHODS.deliveryRead]: (input: DeliveryReadInput) =>
        respond(WS_METHODS.deliveryRead, input),
      [WS_METHODS.deliveryAct]: (input: DeliveryActInput) => respond(WS_METHODS.deliveryAct, input),
    } as unknown as WsRpcProtocolClient;
    const session: RpcSession = {
      client,
      initialConfig: Effect.never,
      subscribeServerConfig: () => Stream.never,
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    supervisors.set(
      environmentId,
      EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: environmentId,
          httpBaseUrl: "https://example.test",
          wsBaseUrl: "wss://example.test",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online" as const,
          phase: "connected" as const,
        }),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      }),
    );
  }
  const run: EnvironmentRegistry["Service"]["run"] = (environmentId, effect) => {
    const supervisor = supervisors.get(environmentId);
    return supervisor
      ? Effect.provideService(effect, EnvironmentSupervisor, supervisor)
      : Effect.fail(new EnvironmentNotRegisteredError({ environmentId }));
  };
  const followStream: EnvironmentRegistry["Service"]["followStream"] = (environmentId, stream) =>
    Stream.provideService(stream, EnvironmentSupervisor, supervisors.get(environmentId)!);
  const stateChanges: EnvironmentRegistry["Service"]["stateChanges"] = (environmentId) =>
    SubscriptionRef.changes(supervisors.get(environmentId)!.state);
  const service = EnvironmentRegistry.of({
    run,
    followStream,
    stateChanges,
  } as unknown as EnvironmentRegistry["Service"]);
  const atoms = createDeliveryEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, service)),
  );
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return { atoms, calls, registry, supervisors };
});

describe("delivery environment routing", () => {
  it.effect("keeps readings of the same task path separate across added environments", () =>
    Effect.gen(function* () {
      const { atoms, calls, registry } = yield* makeHarness();
      const mac = atoms.read({ environmentId: MAC, input: { path: TASK_PATH } });
      const windows = atoms.read({ environmentId: WINDOWS, input: { path: TASK_PATH } });
      yield* AtomRegistry.mount(registry, mac);
      yield* AtomRegistry.mount(registry, windows);
      expect((yield* AtomRegistry.getResult(registry, mac)).body).toEqual({
        environmentId: MAC,
        task: "1016",
      });
      expect((yield* AtomRegistry.getResult(registry, windows)).body).toEqual({
        environmentId: WINDOWS,
        task: "1016",
      });
      expect(calls.filter((call) => call.environmentId === MAC)).toHaveLength(1);
      expect(calls.filter((call) => call.environmentId === WINDOWS)).toHaveLength(1);
    }),
  );

  it.effect("sends task controls and one-off reads only to the selected environment", () =>
    Effect.gen(function* () {
      const { atoms, calls, registry } = yield* makeHarness();
      const input = { path: `${TASK_PATH}/control`, body: { action: "pause", by: "operator" } };
      const changed = yield* Effect.promise(() =>
        atoms.act.run(registry, { environmentId: WINDOWS, input }),
      );
      expect(changed._tag).toBe("Success");
      const reading = yield* Effect.promise(() =>
        atoms.fetch.run(registry, { environmentId: MAC, input: { path: TASK_PATH } }),
      );
      expect(reading._tag).toBe("Success");
      expect(calls).toEqual([
        { environmentId: WINDOWS, method: WS_METHODS.deliveryAct, input },
        { environmentId: MAC, method: WS_METHODS.deliveryRead, input: { path: TASK_PATH } },
      ]);
    }),
  );

  it.effect(
    "does not fall back to the local engine when the selected connection is unavailable or removed",
    () =>
      Effect.gen(function* () {
        const { atoms, calls, registry, supervisors } = yield* makeHarness();
        yield* SubscriptionRef.set(supervisors.get(WINDOWS)!.session, Option.none());
        const input = { path: `${TASK_PATH}/control`, body: { action: "pause" } };
        const disconnected = yield* Effect.promise(() =>
          atoms.act.run(registry, { environmentId: WINDOWS, input }),
        );
        expect(disconnected._tag).toBe("Failure");
        if (AsyncResult.isFailure(disconnected)) {
          expect(Cause.squash(disconnected.cause)).toMatchObject({
            _tag: "EnvironmentRpcUnavailableError",
            environmentId: WINDOWS,
          });
        }
        supervisors.delete(WINDOWS);
        const removed = yield* Effect.promise(() =>
          atoms.fetch.run(registry, { environmentId: WINDOWS, input: { path: TASK_PATH } }),
        );
        expect(removed._tag).toBe("Failure");
        if (AsyncResult.isFailure(removed)) {
          expect(Cause.squash(removed.cause)).toMatchObject({
            _tag: "EnvironmentNotRegisteredError",
            environmentId: WINDOWS,
          });
        }
        expect(calls).toEqual([]);
      }),
  );
});
