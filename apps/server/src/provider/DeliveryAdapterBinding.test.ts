import { assert, it } from "@effect/vitest";
import {
  DeliveryError,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DeliveryThreadSession from "../delivery/DeliveryThreadSession.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  ProviderAdapterOpenSessionError,
  type ProviderAdapterV2,
} from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeClaudeQueryOptions,
  claudeMcpQueryOverrides,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("team-provider");
const threadId = ThreadId.make("team-thread");
const input = {
  threadId,
  providerSessionId: ProviderSessionId.make("team-session"),
  modelSelection: { instanceId, model: "test-model" },
  runtimePolicy: {
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    cwd: "/workspace",
  },
};
const testLayer = (openSession: ProviderAdapterV2["Service"]["openSession"]) => {
  const instance: ProviderInstance = {
    instanceId,
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: "team-provider" },
    displayName: "Team provider",
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    textGeneration: {} as ProviderInstance["textGeneration"],
    orchestrationAdapter: {
      instanceId,
      driver,
      openSession,
      getCapabilities: () => Effect.die("not used"),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    },
  };
  return ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
  );
};

it.effect(
  "a bound team's setup refusal prevents a provider without an auth controller from launching",
  () =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          DeliveryThreadSession.registerDeliveryPreparer((id, actual) => {
            assert.strictEqual(id, threadId);
            assert.deepEqual(actual, { driver: "codex", cwd: "/workspace" });
            return Effect.fail(
              new DeliveryError({ reason: "mismatch", detail: "The bound seat does not match." }),
            );
          }),
        ),
        () => Effect.sync(() => DeliveryThreadSession.registerDeliveryPreparer(undefined)),
      );
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const adapter = yield* registry.get(instanceId);
      const exit = yield* adapter.openSession(input).pipe(Effect.result);
      if (exit._tag !== "Failure") return assert.fail("A mismatched bound seat was admitted.");
      assert.strictEqual(exit.failure._tag, "ProviderAdapterOpenSessionError");
    }).pipe(
      Effect.provide(
        testLayer(() => {
          throw new Error("The bound provider must not launch.");
        }),
      ),
      Effect.scoped,
    ),
);

it.effect("prepared team instructions and stdio tools reach the V2 native provider options", () =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        DeliveryThreadSession.registerDeliveryPreparer(() =>
          Effect.sync(() => {
            DeliveryThreadSession.setDeliveryThreadSession({
              threadId,
              team: "delivery",
              role: "lead",
              configuration: "qualified",
              instructions: "Review the requested acceptance checks.",
              servers: {
                qualified: { command: "node", args: ["team-tool.mjs"], env: { TEAM_MODE: "test" } },
              },
            });
            return true;
          }),
        ),
      ),
      () =>
        Effect.sync(() => {
          DeliveryThreadSession.registerDeliveryPreparer(undefined);
          DeliveryThreadSession.clearDeliveryThreadSession(threadId);
        }),
    );
    const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const adapter = yield* registry.get(instanceId);
    yield* adapter.openSession(input).pipe(Effect.result);
  }).pipe(
    Effect.provide(
      testLayer((actual) =>
        Effect.gen(function* () {
          const options = makeClaudeQueryOptions({
            threadId: actual.threadId,
            modelSelection: actual.modelSelection,
            nativeThreadId: "native",
            resume: false,
            cwd: "/workspace",
          });
          assert.include(
            JSON.stringify(options.systemPrompt),
            "Review the requested acceptance checks.",
          );
          assert.property(
            claudeMcpQueryOverrides({ mcpSession: undefined, threadId, readOnlySandbox: false })
              .mcpServers,
            "qualified",
          );
          assert.property(
            codexThreadRuntimeParams({ mcpSession: undefined, threadId }).config.mcp_servers,
            "qualified",
          );
          return yield* new ProviderAdapterOpenSessionError({
            driver,
            providerSessionId: actual.providerSessionId,
          });
        }),
      ),
    ),
    Effect.scoped,
  ),
);
