import { vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  EnvironmentId,
  ThreadId,
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
import {
  createDeliveryEnvironmentAtoms,
  limitedLeadHandedOn,
  limitedSeatsRevision,
} from "./delivery.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: () => grantedSession }),
}));
const grantedSession = Atom.make(
  AsyncResult.success<AuthSessionState>({
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: [AuthOrchestrationOperateScope],
    permissions: [AuthOrchestrationOperateScope],
  }),
);

const MAC = EnvironmentId.make("mac");
const WINDOWS = EnvironmentId.make("windows");
const TASK_PATH = "/api/tasks/1016";

const makeHarness = Effect.fn("TestDeliveryEnvironments.makeHarness")(function* (
  options: Parameters<typeof createDeliveryEnvironmentAtoms>[1] = {},
  /** The lineup the server holds for a conversation, as its thread-binding read answers. */
  lineup: { current: unknown } = { current: undefined },
) {
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
      [WS_METHODS.deliveryLimitedSeats]: (input: unknown) =>
        respond(WS_METHODS.deliveryLimitedSeats, input).pipe(
          Effect.as({ policy: "swap", notices: [] }),
        ),
      [WS_METHODS.deliveryThreadBinding]: () =>
        Effect.sync(() => ({
          binding: null,
          pending: null,
          ...(lineup.current === undefined ? {} : { lineup: lineup.current }),
        })),
    } as unknown as WsRpcProtocolClient;
    const session: RpcSession = {
      client,
      initialConfig: Effect.never,
      subscribeServerConfig: () => Stream.never,
      ready: Effect.void,
      probe: Effect.void,
      inboundFrames: Effect.succeed(0),
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
    options,
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

  it.effect("shares one board read across subscribers instead of querying each card", () =>
    Effect.gen(function* () {
      const { atoms, calls, registry } = yield* makeHarness();
      const input = { path: "/api/lanes?view=development&set=work" };
      const board = atoms.read({ environmentId: WINDOWS, input });
      for (let index = 0; index < 50; index++) {
        const subscriber = atoms.read({ environmentId: WINDOWS, input });
        expect(subscriber).toBe(board);
        yield* AtomRegistry.mount(registry, subscriber);
      }
      yield* AtomRegistry.getResult(registry, board);
      expect(calls).toEqual([{ environmentId: WINDOWS, method: WS_METHODS.deliveryRead, input }]);
    }),
  );

  it.effect("sends task controls and one-off reads only to the selected environment", () =>
    Effect.gen(function* () {
      const { atoms, calls, registry } = yield* makeHarness();
      const input = { path: `${TASK_PATH}/control`, body: { action: "pause", by: "operator" } };
      yield* atoms.act.run(registry, { environmentId: WINDOWS, input });
      yield* atoms.fetch.run(registry, {
        environmentId: MAC,
        input: { path: TASK_PATH },
      });
      expect(calls).toEqual([
        { environmentId: WINDOWS, method: WS_METHODS.deliveryAct, input },
        { environmentId: MAC, method: WS_METHODS.deliveryRead, input: { path: TASK_PATH } },
      ]);
      const requests = [
        {
          path: "/api/boards/work/deployment",
          body: { deploymentProjectId: "deploy-staging", by: "Sam", key: "test-only-key" },
        },
        {
          path: "/api/boards/work/deployment",
          body: { deploymentProjectId: null, by: "Sam", key: "test-only-key" },
        },
        ...["engine", "boards/work", "tasks/task-1"].map((scope) => ({
          path: `/api/${scope}/merge-permission`,
          body: { mergePermission: "on", confirmed: true, by: "Sam", key: "test-only-key" },
        })),
      ];
      for (const request of requests) {
        yield* atoms.act.run(registry, { environmentId: WINDOWS, input: request });
      }
      expect(calls.slice(2)).toEqual(
        requests.map((input) => ({
          environmentId: WINDOWS,
          method: WS_METHODS.deliveryAct,
          input,
        })),
      );
    }),
  );

  it.effect(
    "does not fall back to the local engine when the selected connection is unavailable or removed",
    () =>
      Effect.gen(function* () {
        const { atoms, calls, registry, supervisors } = yield* makeHarness();
        yield* SubscriptionRef.set(supervisors.get(WINDOWS)!.session, Option.none());
        const input = { path: `${TASK_PATH}/control`, body: { action: "pause" } };
        const disconnected = yield* Effect.exit(
          atoms.act.run(registry, { environmentId: WINDOWS, input }),
        );
        expect(disconnected._tag).toBe("Failure");
        if (disconnected._tag === "Failure") {
          expect(Cause.squash(disconnected.cause)).toMatchObject({
            _tag: "EnvironmentRpcUnavailableError",
            environmentId: WINDOWS,
          });
        }
        supervisors.delete(WINDOWS);
        const removed = yield* Effect.exit(
          atoms.fetch.run(registry, { environmentId: WINDOWS, input: { path: TASK_PATH } }),
        );
        expect(removed._tag).toBe("Failure");
        if (removed._tag === "Failure") {
          expect(Cause.squash(removed.cause)).toMatchObject({
            _tag: "EnvironmentNotRegisteredError",
            environmentId: WINDOWS,
          });
        }
        expect(calls).toEqual([]);
      }),
  );
});

describe("limited-seat notices", () => {
  const thread = ThreadId.make("lead-thread");
  const run = (runId: string, status: string) =>
    ({ latestRun: { runId, status }, runtime: null, modelSelection: fable }) as never;
  const fable = { instanceId: "claude", model: "claude-fable" };
  const provider = (overrides: Record<string, unknown> = {}) =>
    ({
      instanceId: "kimi",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      usageLimits: { windows: [{ id: "weekly", usedPercent: 40 }] },
      ...overrides,
    }) as never;
  const base = {
    shell: run("run-1", "failed"),
    continued: null,
    lineup: { participants: [], limitedSeat: "ask" } as never,
    settings: { favorites: [{ provider: "kimi", model: "kimi-k3" }] } as never,
    providers: [provider()],
  };

  it("change with everything a notice is decided from, and with nothing else", () => {
    const revision = limitedSeatsRevision(base);
    const changes = {
      "the setting": { lineup: { participants: [], limitedSeat: "skip" } as never },
      "the lineup's seats": {
        lineup: {
          participants: [{ seat: "critic", role: "reviewer", modelSelection: fable }],
          limitedSeat: "ask",
        } as never,
      },
      "Favorites and their order": {
        settings: {
          favorites: [
            { provider: "deepseek", model: "deepseek-v4" },
            { provider: "kimi", model: "kimi-k3" },
          ],
        } as never,
      },
      "a provider turned off": { providers: [provider({ enabled: false })] },
      "a provider signed out": { providers: [provider({ auth: { status: "unauthenticated" } })] },
      "a provider reaching its limit": {
        providers: [provider({ usageLimits: { windows: [{ id: "weekly", usedPercent: 100 }] } })],
      },
      "the run": { shell: run("run-2", "running") },
      "the thread the run was handed on to": {
        continued: { latestRun: null, runtime: null, modelSelection: fable } as never,
      },
    };
    for (const [name, change] of Object.entries(changes))
      expect(limitedSeatsRevision({ ...base, ...change }), name).not.toBe(revision);
    // A usage window filling up is not a change until it is full.
    expect(
      limitedSeatsRevision({
        ...base,
        providers: [provider({ usageLimits: { windows: [{ id: "weekly", usedPercent: 41 }] } })],
      }),
    ).toBe(revision);
    // The handed-on thread's first turn changes its model, and the notice names that model.
    const forked = { latestRun: null, runtime: null, modelSelection: fable } as never;
    const started = {
      latestRun: { runId: "run-c", status: "running" },
      runtime: null,
      modelSelection: { instanceId: "kimi", model: "kimi-k3" },
    } as never;
    expect(limitedSeatsRevision({ ...base, continued: started })).not.toBe(
      limitedSeatsRevision({ ...base, continued: forked }),
    );
  });

  it("knows a limited run was handed on by the thread it continues in", () => {
    const continued = new Set(["limited-lead:run-1"]);
    const has = (threadId: ThreadId) => continued.has(threadId);
    expect(limitedLeadHandedOn(run("run-1", "failed"), has)).toBe(true);
    expect(limitedLeadHandedOn(run("run-2", "failed"), has)).toBe(false);
    expect(limitedLeadHandedOn(null, has)).toBe(false);
  });

  it.effect("are read again when the lineup, Favorites or a provider changes", () =>
    Effect.gen(function* () {
      const settings = Atom.make<object>(base.settings as object).pipe(Atom.keepAlive);
      const providers = Atom.make<object>(base.providers as object).pipe(Atom.keepAlive);
      const shells = Atom.family((threadId: string) =>
        Atom.make<object | null>(threadId === thread ? (base.shell as object) : null).pipe(
          Atom.keepAlive,
        ),
      );
      const lineup = { current: base.lineup as unknown };
      const { atoms, calls, registry } = yield* makeHarness(
        {
          threadShellAtom: (ref) => shells(ref.threadId) as never,
          settingsAtom: () => settings as never,
          providersAtom: () => providers as never,
        },
        lineup,
      );
      const target = { environmentId: MAC, input: { threadId: thread } };
      const query = atoms.limitedSeats(target);
      const reads = () =>
        calls.filter((call) => call.method === WS_METHODS.deliveryLimitedSeats).length;
      const read = AtomRegistry.getResult(registry, query, { suspendOnWaiting: true }).pipe(
        Effect.tap(() => Effect.yieldNow),
      );
      registry.mount(query);
      registry.mount(atoms.limitedLeadHandedOn({ environmentId: MAC, threadId: thread }));
      yield* read;
      yield* AtomRegistry.getResult(registry, atoms.threadBinding(target));
      yield* read;
      const settled = reads();

      registry.set(settings, { favorites: [] });
      yield* read;
      expect(reads()).toBe(settled + 1);

      registry.set(providers, [provider({ enabled: false })]);
      yield* read;
      expect(reads()).toBe(settled + 2);

      // The lineup panel saves a new setting, then reads the conversation's state again.
      lineup.current = { participants: [], limitedSeat: "skip" };
      registry.refresh(atoms.threadBinding(target));
      yield* AtomRegistry.getResult(registry, atoms.threadBinding(target), {
        suspendOnWaiting: true,
      });
      yield* read;
      expect(reads()).toBe(settled + 3);

      // The run is handed on: the old thread stops offering its resume, and reads its notice.
      const handedOn = atoms.limitedLeadHandedOn({ environmentId: MAC, threadId: thread });
      expect(registry.get(handedOn)).toBe(false);
      registry.set(shells("limited-lead:run-1"), {
        latestRun: null,
        runtime: null,
        modelSelection: fable,
      });
      expect(registry.get(handedOn)).toBe(true);
      yield* read;
      expect(reads()).toBe(settled + 4);
    }),
  );
});
