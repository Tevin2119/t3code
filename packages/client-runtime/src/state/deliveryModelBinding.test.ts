import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type DeliveryThreadBinding,
  type DeliveryThreadState,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createDeliveryEnvironmentAtoms } from "./delivery.ts";

it.effect(
  "isolates confirmed bindings across thread/environment changes and pending RPC results",
  () =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<{
        environmentId: string;
        threadId: string;
        result: Deferred.Deferred<DeliveryThreadState>;
      }>();
      const supervisors = new Map<string, EnvironmentSupervisor.EnvironmentSupervisor["Service"]>();
      for (const id of ["work", "personal"]) {
        const target = new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make(id),
          label: id,
          httpBaseUrl: "https://example.test",
          wsBaseUrl: "wss://example.test",
        });
        const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          phase: "connected" as const,
          generation: 1,
        });
        const session = {
          client: {
            [WS_METHODS.deliveryThreadBinding]: (input: { threadId: string }) =>
              Effect.gen(function* () {
                const result = yield* Deferred.make<DeliveryThreadState>();
                yield* Queue.offer(requests, {
                  environmentId: id,
                  threadId: input.threadId,
                  result,
                });
                return yield* Deferred.await(result);
              }),
          },
        } as unknown as RpcSession;
        supervisors.set(
          id,
          EnvironmentSupervisor.EnvironmentSupervisor.of({
            target,
            state,
            session: yield* SubscriptionRef.make(Option.some(session)),
            prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          }),
        );
      }
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (id, effect) =>
        Effect.provideService(
          effect,
          EnvironmentSupervisor.EnvironmentSupervisor,
          supervisors.get(id)!,
        );
      const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
        id,
        stream,
      ) =>
        Stream.provideService(
          stream,
          EnvironmentSupervisor.EnvironmentSupervisor,
          supervisors.get(id)!,
        );
      const service = EnvironmentRegistry.EnvironmentRegistry.of({
        run,
        followStream,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const atoms = createDeliveryEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, service)),
      );
      const registry = AtomRegistry.make();
      const unmounts: Array<() => void> = [];
      try {
        const binding: DeliveryThreadBinding = {
          threadId: ThreadId.make("same-id"),
          session: "session",
          team: "development",
          role: "implementer",
          seat: "developer",
          harness: "pi",
          driver: "pi",
          workspace: "/repo",
          configuration: "development@1#digest",
          requestedModel: null,
          memoryScope: "team",
          tools: [],
          project: "project",
          boundAt: "2026-10-13T00:00:00Z",
        };
        for (const [environmentId, threadId, nextBinding] of [
          ["work", "same-id", binding],
          ["work", "unbound", null],
          ["personal", "same-id", null],
          [
            "personal",
            "different",
            {
              ...binding,
              threadId: ThreadId.make("different"),
              team: "review",
              role: "reviewer",
              harness: "claude",
              driver: "claudeAgent",
            },
          ],
        ] as const) {
          const target = {
            environmentId: EnvironmentId.make(environmentId),
            input: { threadId: ThreadId.make(threadId) },
          };
          const modelBinding = atoms.modelBinding(target);
          unmounts.push(registry.mount(modelBinding));
          expect(registry.get(modelBinding)).toBeNull();
          const request = yield* Queue.take(requests);
          expect([request.environmentId, request.threadId]).toEqual([environmentId, threadId]);
          yield* Deferred.succeed(request.result, { binding: nextBinding, pending: null });
          yield* AtomRegistry.getResult(registry, atoms.threadBinding(target), {
            suspendOnWaiting: true,
          });
          expect(registry.get(modelBinding)).toEqual(nextBinding);
        }
        const heldTarget = {
          environmentId: EnvironmentId.make("work"),
          input: { threadId: ThreadId.make("pending") },
        };
        const held = atoms.modelBinding(heldTarget);
        unmounts.push(registry.mount(held));
        const request = yield* Queue.take(requests);
        yield* Deferred.succeed(request.result, {
          binding: null,
          pending: {
            threadId: heldTarget.input.threadId,
            team: "development",
            role: "implementer",
            driver: "pi",
            cwd: "/repo",
            since: "today",
            why: null,
          },
        });
        yield* AtomRegistry.getResult(registry, atoms.threadBinding(heldTarget), {
          suspendOnWaiting: true,
        });
        expect(registry.get(held)).toBeNull();
        const original = atoms.modelBinding({
          environmentId: EnvironmentId.make("work"),
          input: { threadId: binding.threadId },
        });
        expect(registry.get(original)).toEqual(binding);
      } finally {
        for (const unmount of unmounts) unmount();
        registry.dispose();
      }
    }),
);
