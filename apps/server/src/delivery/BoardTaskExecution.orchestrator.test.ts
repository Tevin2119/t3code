import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import { briefMessageId, stageMessageId } from "./boardTaskAttempts.ts";
import * as BoardTaskExecution from "./BoardTaskExecution.ts";
import * as BoardTaskThreads from "./BoardTaskThreads.ts";
import { scratchEngine, scratchEngineHttp } from "./boardThreadEngine.testkit.ts";
import {
  boardTaskOf,
  boardTaskThreadCommandId,
  boardTaskThreadId,
  createBoardTaskThread,
} from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";

// The commands BoardTaskExecution sends, through the real orchestrator: what it refuses here, a
// board task's step would never run. BoardTaskExecution.test.ts covers the rest on a store.

const ENVIRONMENT = EnvironmentId.make("471fea73-5365-4bbb-96eb-8e35be50eaec");
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const runSelection = { instanceId, model: "test-model" };
const TASK = boardTaskOf("work", "task-7")!;
const THREAD = boardTaskThreadId(TASK);

/** A provider that starts each turn and leaves it running, as a long engine step does. */
const harness = Effect.fn("harness")(function* (name: string) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const turnUpdated = (
          turn: ProviderAdapter.ProviderAdapterV2TurnInput,
          status: "running" | "interrupted",
        ) =>
          Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
              providerThreadId: turn.providerThread.id,
              nodeId: turn.rootNodeId,
              runAttemptId: turn.attemptId,
              nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
              ordinal: turn.providerTurnOrdinal,
              status,
              startedAt: now,
              completedAt: status === "running" ? null : now,
            },
          });
        const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.sync(() => started.push(turn)).pipe(Effect.andThen(turnUpdated(turn, "running")));
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: runSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn,
          compactThread: startTurn,
          steerTurn: () => Effect.void,
          interruptTurn: ({ providerTurnId }) =>
            Effect.forEach(
              started.filter(
                (turn) => ProviderTurnId.make(`provider-turn:${turn.attemptId}`) === providerTurnId,
              ),
              (turn) =>
                turnUpdated(turn, "interrupted").pipe(
                  Effect.andThen(
                    Queue.offer(events, {
                      type: "turn.terminal",
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId,
                      runOrdinal: turn.runOrdinal,
                      status: "interrupted",
                      failure: null,
                      threadDisposition: "reusable",
                    }),
                  ),
                ),
              { discard: true },
            ),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(adapter),
    { runEffectWorker: false },
  );
  return { cwd, layer };
});

/** The service over the real orchestrator, with the scratch engine behind the delivery client. */
const execution = () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* BoardTaskExecution.make.pipe(
      Effect.provideService(ThreadManagementService.ThreadManagementService, {
        dispatch: orchestrator.dispatch,
      } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        getThreadRecords: orchestrator.getThreadRecords,
        getMessagesById: orchestrator.getMessagesById,
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Effect.provideService(BoardTaskThreads.BoardTaskThreads, {
        holdTask: () => Effect.succeed(true),
      } as unknown as BoardTaskThreads.BoardTaskThreads["Service"]),
      Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        listInstances: Effect.succeed([{ instanceId, driverKind: driver, enabled: true }]),
      } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]),
      Effect.provideService(HostProcess.Environment, {
        [DeliveryService.BOARD_THREAD_KEY_VARIABLE]: "scratch approval passphrase",
      }),
      Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(ENVIRONMENT),
      }),
      Effect.provide(IdAllocator.layer),
    );
  });

/**
 * The delivery service as the server runs it, with the scratch engine behind its client. Given
 * to the whole case: a request reads the host environment it runs in, never this machine's.
 */
const deliveryLayer = (engine: ReturnType<typeof scratchEngine>) =>
  Layer.fresh(DeliveryService.layer(deriveProviderInstanceConfigMap)).pipe(
    Layer.provideMerge(Layer.succeed(HostProcess.Environment, {})),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "board-execution-real-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      ServerSettings.layerTest({
        delivery: { enabled: true, engineUrl: "http://127.0.0.1:4320" },
      }),
    ),
    Layer.provideMerge(scratchEngineHttp(engine)),
  );

const createThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch(
    createBoardTaskThread(TASK, {
      commandId: boardTaskThreadCommandId(TASK),
      threadId: THREAD,
      projectId: ProjectId.make("project:board"),
      title: "Ship the export",
      modelSelection: runSelection,
    }),
  );
});

const board = () => {
  const engine = scratchEngine();
  engine.addTask({ id: "task-7", title: "Ship the export" });
  engine.writeLink("task-7", { environmentId: ENVIRONMENT, threadId: THREAD, setBy: ENVIRONMENT });
  return engine;
};

it.effect("sends the brief, lead steps and seats as turns the orchestrator takes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer } = yield* harness("board-execution-real-turns");
      const engine = board();
      const body = Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* createThread;
        const step = { task: "task-7", worktree: cwd, harness: "codex", model: "test-model" };
        engine.queueAttempt({
          ...step,
          id: "att-plan",
          stage: "plan",
          kind: "team-plan",
          seat: "lead",
          lead: true,
          access: "read-only",
        });
        engine.queueAttempt({
          ...step,
          id: "att-review",
          stage: "review",
          kind: "review",
          seat: "lead",
          lead: true,
          access: "read-only",
        });
        engine.queueAttempt({
          ...step,
          id: "att-qa",
          stage: "qa",
          kind: "qa",
          seat: "qa",
          access: "read-only",
        });
        const service = yield* execution();
        yield* service.reconcile();
        yield* worker.drain();
        const projection = yield* orchestrator.getThreadProjection(THREAD);
        // The brief is a turn of the thread, in the engine's worktree; each stage turn is a
        // queued agent notice, which the orchestrator refuses in any other form.
        assert.equal(projection.thread.worktreePath, cwd);
        assert.equal(projection.thread.runtimeMode, "approval-required");
        for (const messageId of [
          briefMessageId("att-plan"),
          stageMessageId("att-review"),
          stageMessageId("att-qa"),
        ])
          assert.isDefined(
            projection.runs.find((run) => run.userMessageId === messageId),
            `the orchestrator took ${messageId}`,
          );
        assert.deepEqual(
          ["att-plan", "att-review", "att-qa"].map(
            (id) => engine.attempts.get(id)!.native !== null,
          ),
          [true, true, true],
        );
      }).pipe(Effect.provide(deliveryLayer(engine)));
      // The orchestrator's layer around the case, the delivery service's within it.
      yield* body.pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("cancels a stage turn still queued behind the brief", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer } = yield* harness("board-execution-real-stop");
      const engine = board();
      const body = Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* createThread;
        const step = { task: "task-7", worktree: cwd, harness: "codex", model: "test-model" };
        engine.queueAttempt({
          ...step,
          id: "att-plan",
          stage: "plan",
          kind: "team-plan",
          seat: "lead",
          lead: true,
        });
        engine.queueAttempt({
          ...step,
          id: "att-build",
          stage: "build",
          kind: "build",
          seat: "dev",
        });
        const service = yield* execution();
        yield* service.reconcile();
        yield* worker.drain();
        const before = yield* orchestrator.getThreadProjection(THREAD);
        const runOf = (projection: typeof before, messageId: MessageId) =>
          projection.runs.find((run) => run.userMessageId === messageId);
        assert.equal(runOf(before, stageMessageId("att-build"))?.status, "queued");
        assert.notEqual(runOf(before, briefMessageId("att-plan"))?.status, "queued");
        // The engine stops the build while its stage turn still waits behind the brief.
        engine.cancelAttempt("att-build");
        yield* service.reconcile();
        yield* worker.drain();
        const after = yield* orchestrator.getThreadProjection(THREAD);
        // A queued turn is cancelled, never interrupted, which the orchestrator refuses; so no
        // child of it ever starts.
        assert.equal(runOf(after, stageMessageId("att-build"))?.status, "cancelled");
        yield* service.reconcile();
        assert.equal(engine.attempts.get("att-build")!.state, "cancelled");
        // Nothing ran it, so it is told no model or harness.
        assert.isNull(engine.attempts.get("att-build")!.result?.model);
        assert.isNull(engine.attempts.get("att-build")!.result?.harness);
      }).pipe(Effect.provide(deliveryLayer(engine)));
      // The orchestrator's layer around the case, the delivery service's within it.
      yield* body.pipe(Effect.provide(layer));
    }),
  ),
);
