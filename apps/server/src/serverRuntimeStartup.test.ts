import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_MODEL,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

import * as ServerConfig from "./config.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

it("uses the canonical Codex model for auto-bootstrap", () => {
  assert.deepEqual(ServerRuntimeStartup.getAutoBootstrapThreadModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("starts without scanning or rebuilding projection history", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (label: string) => Ref.update(calls, (current) => [...current, label]);

    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      importLegacyShells: record("import"),
      recover: record("recover").pipe(Effect.as({ closedRequests: 2 })),
      recoverDelegatedTasks: record("delegated"),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap").pipe(Effect.as({ projectId: "project-1" })),
    });

    // Delegated recovery reads the runs recovery terminalizes, and settles them
    // before the worker runs restart continuations that would otherwise race it.
    assert.deepEqual(yield* Ref.get(calls), [
      "import",
      "recover",
      "delegated",
      "worker",
      "bootstrap",
    ]);
    assert.deepEqual(result, {
      recovery: { closedRequests: 2 },
      bootstrap: { projectId: "project-1" },
    });
  }),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerInterrupted = yield* Ref.make(false);
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Ref.get(workerInterrupted));
      assert.isNull(yield* Ref.get(workerFiberRef));
    }),
  ),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("restart closes an already ready command gate and late startup cannot reopen it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const ran = yield* Ref.make(false);
      yield* gate.signalCommandReady;
      yield* gate.awaitCommandReady;
      const failure = new ServerRuntimeStartup.ServerRuntimeStartupError({
        mode: "web",
        host: "127.0.0.1",
        port: 3773,
        cause: "Restart preparation",
      });
      yield* gate.failCommandReady(failure);
      yield* gate.signalCommandReady;
      assert.strictEqual(yield* Effect.flip(gate.awaitCommandReady), failure);
      assert.strictEqual(yield* Effect.flip(gate.enqueueCommand(Ref.set(ran, true))), failure);
      assert.isFalse(yield* Ref.get(ran));
    }),
  ),
);

it.effect(
  "restart interrupts the live worker before persisting continuations and shares preparation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const record = (name: string) => Ref.update(calls, (current) => [...current, name]);
        const workerStarted = yield* Deferred.make<void>();
        const persisting = yield* Deferred.make<void>();
        const releasePersistence = yield* Deferred.make<void>();
        const worker = yield* Deferred.succeed(workerStarted, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(record("worker-stopped")),
          Effect.forkScoped,
        );
        yield* Deferred.await(workerStarted);
        const prepare = yield* ServerRuntimeStartup.makeRestartPreparation({
          denyCommands: record("deny"),
          interruptEffectWorker: Fiber.interrupt(worker),
          persistContinuations: record("persist").pipe(
            Effect.andThen(Deferred.succeed(persisting, undefined)),
            Effect.andThen(Deferred.await(releasePersistence)),
          ),
          stopProviderSessions: record("provider-stop"),
          reconcile: record("reconcile"),
        });
        const first = yield* prepare.pipe(Effect.forkScoped);
        yield* Deferred.await(persisting);
        const second = yield* prepare.pipe(Effect.forkScoped);
        assert.deepEqual(yield* Ref.get(calls), ["deny", "worker-stopped", "persist"]);
        yield* Deferred.succeed(releasePersistence, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        yield* prepare;
        assert.deepEqual(yield* Ref.get(calls), [
          "deny",
          "worker-stopped",
          "persist",
          "provider-stop",
          "reconcile",
        ]);
      }),
    ),
);

it.effect("failed persistence still stops providers and caches failure without reconciling", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (name: string) => Ref.update(calls, (current) => [...current, name]);
    const prepare = yield* ServerRuntimeStartup.makeRestartPreparation({
      denyCommands: record("deny"),
      interruptEffectWorker: record("worker-stop"),
      persistContinuations: record("persist").pipe(
        Effect.andThen(Effect.fail("persistence failed")),
      ),
      stopProviderSessions: record("provider-stop"),
      reconcile: record("reconcile"),
    });
    assert.equal(yield* Effect.flip(prepare), "persistence failed");
    assert.equal(yield* Effect.flip(prepare), "persistence failed");
    assert.deepEqual(yield* Ref.get(calls), ["deny", "worker-stop", "persist", "provider-stop"]);
  }),
);

it.effect("interrupting a preparation caller cannot leave a cached partial shutdown", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const interruptStarted = yield* Deferred.make<void>();
      const completed = yield* Ref.make(false);
      const prepare = yield* ServerRuntimeStartup.makeRestartPreparation({
        denyCommands: Effect.void,
        interruptEffectWorker: Effect.void,
        persistContinuations: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
        stopProviderSessions: Effect.void,
        reconcile: Ref.set(completed, true),
      });
      const caller = yield* prepare.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const interrupt = yield* Deferred.succeed(interruptStarted, undefined).pipe(
        Effect.andThen(Fiber.interrupt(caller)),
        Effect.forkScoped,
      );
      yield* Deferred.await(interruptStarted);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupt);
      yield* prepare;
      assert.isTrue(yield* Ref.get(completed));
    }),
  ),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);
