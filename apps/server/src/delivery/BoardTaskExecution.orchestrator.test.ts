import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type RunId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import { briefMessageId, stageMessageId } from "./boardTaskAttempts.ts";
import * as BoardTaskExecution from "./BoardTaskExecution.ts";
import * as BoardTaskThreads from "./BoardTaskThreads.ts";
import * as BoardThreadRows from "./boardThreadRows.ts";
import {
  scratchEngine,
  scratchEngineHttp,
  type ScratchEngine,
} from "./boardThreadEngine.testkit.ts";
import {
  boardTaskOf,
  boardTaskThreadCommandId,
  boardTaskThreadId,
  createBoardTaskThread,
} from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";

// A board task's engine steps on the real stack: the orchestrator, ProviderTurnStartService and
// NativeTeamChat, with a scripted provider and the scratch engine. Each seat starts, wakes its
// stage turn and stops on the paths a delegated task and a team round already take.
// BoardTaskExecution.test.ts covers the rest on a store.

const ENVIRONMENT = EnvironmentId.make("471fea73-5365-4bbb-96eb-8e35be50eaec");
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const runSelection = { instanceId, model: "test-model" };
/** What the provider says each turn ran on, which differs from the model it was asked for. */
const RAN = "test-model-0601";
const TASK = boardTaskOf("work", "task-7")!;
const THREAD = boardTaskThreadId(TASK);

/** The delivery service as the server runs it, with the scratch engine behind its client. */
const deliveryLayer = (engine: ScratchEngine, prefix: string) =>
  Layer.fresh(DeliveryService.layer(deriveProviderInstanceConfigMap)).pipe(
    Layer.provideMerge(Layer.succeed(HostProcess.Environment, {})),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      ServerSettings.layerTest({
        delivery: { enabled: true, engineUrl: "http://127.0.0.1:4320" },
      }),
    ),
    Layer.provideMerge(scratchEngineHttp(engine)),
  );

const instances = {
  listInstances: Effect.succeed([{ instanceId, driverKind: driver, enabled: true }]),
  getInstance: () => Effect.undefined,
} as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];

/**
 * A provider that runs each turn until the case ends it, one event stream per session, and
 * reports the model it ran on. Its runs are prepared as the launch service prepares a delegated
 * task in a worktree that exists: released, once its folder is ready.
 */
const harness = Effect.fn("harness")(function* (name: string, engine: ScratchEngine) {
  const cwd = yield* checkpointWorkspace(name);
  const sessions = new Map<string, Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>>();
  const started: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
  const queueOf = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
    sessions.get(turn.providerThread.providerSessionId ?? "")!;
  const providerTurn = (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
    status: "running" | "completed" | "interrupted",
    now: DateTime.Utc,
  ) => ({
    id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
    providerThreadId: turn.providerThread.id,
    nodeId: turn.rootNodeId,
    runAttemptId: turn.attemptId,
    nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" as const },
    ordinal: turn.providerTurnOrdinal,
    status,
    model: RAN,
    startedAt: now,
    completedAt: status === "running" ? null : now,
  });
  const end = (turn: ProviderAdapter.ProviderAdapterV2TurnInput, status: "interrupted") =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* Queue.offer(queueOf(turn), {
        type: "provider_turn.updated",
        driver,
        threadId: turn.threadId,
        providerTurn: providerTurn(turn, status, now),
      });
      yield* Queue.offer(queueOf(turn), {
        type: "turn.terminal",
        driver,
        providerThreadId: turn.providerThread.id,
        providerTurnId: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
        runOrdinal: turn.runOrdinal,
        status,
        failure: null,
        threadDisposition: "reusable",
      });
    });
  /** The turn's answer, and its end. */
  const answer = (turn: ProviderAdapter.ProviderAdapterV2TurnInput, text: string) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const id = ProviderTurnId.make(`provider-turn:${turn.attemptId}`);
      yield* Queue.offer(queueOf(turn), {
        type: "turn_item.updated",
        driver,
        turnItem: {
          id: TurnItemId.make(`answer:${turn.attemptId}`),
          threadId: turn.threadId,
          runId: turn.runId,
          nodeId: turn.rootNodeId,
          providerTurnId: id,
          ordinal: 10,
          type: "assistant_message",
          status: "completed",
          text,
          providerThreadId: turn.providerThread.id,
          nativeItemRef: null,
          parentItemId: null,
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          messageId: MessageId.make(`answer:${turn.attemptId}`),
          streaming: false,
        },
      });
      yield* Queue.offer(queueOf(turn), {
        type: "provider_turn.updated",
        driver,
        threadId: turn.threadId,
        providerTurn: providerTurn(turn, "completed", now),
      });
      yield* Queue.offer(queueOf(turn), {
        type: "turn.terminal",
        driver,
        providerThreadId: turn.providerThread.id,
        providerTurnId: id,
        runOrdinal: turn.runOrdinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
    });
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        sessions.set(input.providerSessionId, events);
        const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            started.push(turn);
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              threadId: turn.threadId,
              providerTurn: providerTurn(turn, "running", yield* DateTime.now),
            });
          });
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
              nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
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
              (turn) => end(turn, "interrupted"),
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
    {
      runEffectWorker: false,
      teamChat: Layer.mergeAll(
        deliveryLayer(engine, `${name}-team-`),
        Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, instances),
      ).pipe(Layer.orDie),
    },
  );
  const turnsOf = (threadId: ThreadId) => started.filter((turn) => turn.threadId === threadId);
  const seatTurns = () => started.filter((turn) => turn.threadId !== THREAD);
  return { cwd, layer, started, answer, turnsOf, seatTurns };
});

/** The service over the real orchestrator, with the scratch engine behind the delivery client. */
const execution = () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    return yield* BoardTaskExecution.make.pipe(
      Effect.provideService(ThreadManagementService.ThreadManagementService, {
        dispatch: orchestrator.dispatch,
        cancelDelegatedTask: orchestrator.cancelDelegatedTask,
        stopDelegatedTasks: () => Effect.void,
        hasReceipt: (commandId: CommandId) =>
          receipts.getByCommandId(commandId).pipe(
            Effect.map(Option.isSome),
            Effect.orElseSucceed(() => false),
          ),
      } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        getThreadRecords: orchestrator.getThreadRecords,
        getMessagesById: orchestrator.getMessagesById,
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Effect.provideService(BoardTaskThreads.BoardTaskThreads, {
        holdTask: () => Effect.succeed(true),
      } as unknown as BoardTaskThreads.BoardTaskThreads["Service"]),
      Effect.provideService(BoardThreadRows.BoardThreadRows, {
        list: () => Effect.succeed([{ threadId: THREAD }]),
      } as unknown as BoardThreadRows.BoardThreadRows["Service"]),
      Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, instances),
      // A worktree that exists is prepared by releasing its run once its folder is ready, the
      // last step of the launch service's own preparation; setup scripts are not this case's.
      Effect.provideService(ThreadLaunchService.ThreadLaunchService, {
        prepareRun: (input: { commandId: CommandId; threadId: ThreadId; runId: RunId }) =>
          Effect.gen(function* () {
            const { runs } = yield* orchestrator.getThreadRecords(input.threadId, ["runs"]);
            const preparation = runs.find((run) => run.id === input.runId)?.workspacePreparation;
            if (preparation?.type === "existing_worktree")
              yield* orchestrator.dispatch({
                type: "thread.metadata.update",
                commandId: CommandId.make(`${input.commandId}:folder`),
                threadId: input.threadId,
                worktreePath: preparation.worktreePath,
              });
            yield* orchestrator.dispatch({
              type: "prepared-run.release",
              commandId: CommandId.make(`${input.commandId}:release`),
              threadId: input.threadId,
              runId: input.runId,
            });
          }).pipe(Effect.ignore),
      } as unknown as ThreadLaunchService.ThreadLaunchService["Service"]),
      Effect.provideService(HostProcess.Environment, {
        [DeliveryService.BOARD_THREAD_KEY_VARIABLE]: "scratch approval passphrase",
      }),
      Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(ENVIRONMENT),
      }),
      Effect.provide(IdAllocator.layer),
    );
  });

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

/**
 * Lets the orchestrator apply what was sent and what the provider reported: the effect worker's
 * queue, then the event fibers that run as the test clock moves, a few hops deep.
 */
const settle = Effect.gen(function* () {
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  yield* worker.drain();
  yield* TestClock.adjust("5 seconds");
  yield* worker.drain();
  yield* TestClock.adjust("5 seconds");
  yield* worker.drain();
  yield* TestClock.adjust("5 seconds");
  yield* worker.drain();
});

const board = () => {
  const engine = scratchEngine();
  engine.addTask({ id: "task-7", title: "Ship the export" });
  engine.writeLink("task-7", { environmentId: ENVIRONMENT, threadId: THREAD, setBy: ENVIRONMENT });
  return engine;
};

it.effect("runs a stage's seats to the end, wakes the lead, and reports what really ran", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const engine = board();
      const { cwd, layer, answer, turnsOf, seatTurns } = yield* harness(
        "board-execution-real-stage",
        engine,
      );
      for (const id of ["att-qa-1", "att-qa-2"])
        engine.queueAttempt({
          id,
          task: "task-7",
          stage: "qa",
          kind: "qa",
          seat: id,
          worktree: cwd,
          harness: "codex",
          model: "test-model",
        });
      const body = Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* createThread;
        const service = yield* execution();
        yield* service.reconcile();
        yield* settle;
        // The next pass prepares each seat's run, as the seat's start wakes it in the server.
        yield* service.reconcile();
        yield* settle;
        assert.lengthOf(seatTurns(), 2, "both seats run");
        let projection = yield* orchestrator.getThreadProjection(THREAD);
        const stage = projection.runs.find(
          (run) => run.userMessageId === stageMessageId("att-qa-1"),
        )!;
        // Held at its start while its seats work.
        assert.equal(stage.status, "starting");
        assert.lengthOf(turnsOf(THREAD), 0);
        assert.deepEqual(
          projection.subagents.map((task) => task.teamChat?.stage),
          ["engine", "engine"],
        );
        for (const task of projection.subagents)
          assert.equal(
            (yield* orchestrator.getThreadProjection(task.childThreadId!)).thread.worktreePath,
            cwd,
          );
        // Each seat's end wakes the turn held at its start; once both have ended, the lead's
        // turn runs with their results.
        for (const [index, turn] of seatTurns().entries())
          yield* answer(turn, `QA ${index + 1}: all items pass.`);
        yield* settle;
        const [lead] = turnsOf(THREAD);
        assert.isDefined(lead, "the lead's turn started");
        assert.include(lead!.message.text, "Engine:");
        yield* answer(lead!, "Both QA seats pass; the task is ready for review.");
        yield* settle;
        projection = yield* orchestrator.getThreadProjection(THREAD);
        assert.equal(projection.runs.find((run) => run.id === stage.id)?.status, "completed");
        yield* service.reconcile();
        for (const [index, id] of ["att-qa-1", "att-qa-2"].entries()) {
          const record = engine.attempts.get(id)!;
          assert.equal(record.state, "completed");
          assert.deepInclude(record.result!, {
            text: `QA ${index + 1}: all items pass.`,
            model: RAN,
            harness: "codex",
          });
        }
      }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-real-stage-")));
      yield* body.pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("stops a running seat the engine cancels, as a delegated task is cancelled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const engine = board();
      const { cwd, layer, seatTurns } = yield* harness("board-execution-real-cancel", engine);
      engine.queueAttempt({
        id: "att-build",
        task: "task-7",
        stage: "build",
        kind: "build",
        seat: "developer",
        worktree: cwd,
        harness: "codex",
        model: "test-model",
      });
      const body = Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* createThread;
        const service = yield* execution();
        yield* service.reconcile();
        yield* settle;
        yield* service.reconcile();
        yield* settle;
        assert.lengthOf(seatTurns(), 1, "the seat runs");
        engine.cancelAttempt("att-build");
        yield* service.reconcile();
        // A stop waits a grace period for the provider to confirm, which the clock passes.
        yield* settle;
        const [task] = (yield* orchestrator.getThreadProjection(THREAD)).subagents;
        assert.include(["cancelled", "interrupted"], task?.status);
        yield* service.reconcile();
        assert.include(["cancelled", "interrupted"], engine.attempts.get("att-build")!.state);
      }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-real-cancel-")));
      yield* body.pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("gives the thread back its folder and mode after a person's turn ends", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const engine = board();
      const { cwd, layer, answer, turnsOf } = yield* harness(
        "board-execution-real-give-back",
        engine,
      );
      engine.queueAttempt({
        id: "att-plan",
        task: "task-7",
        stage: "plan",
        kind: "team-plan",
        seat: "lead",
        lead: true,
        access: "read-only",
        worktree: cwd,
        harness: "codex",
        model: "test-model",
      });
      const body = Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* createThread;
        const service = yield* execution();
        yield* service.reconcile();
        yield* settle;
        assert.lengthOf(turnsOf(THREAD), 1, "the brief runs");
        let thread = (yield* orchestrator.getThreadProjection(THREAD)).thread;
        assert.equal(thread.worktreePath, cwd);
        assert.equal(thread.runtimeMode, "approval-required");
        yield* answer(turnsOf(THREAD)[0]!, '{"approach":"Ship it"}');
        yield* settle;
        // A person writes as the plan ends, before T3's next pass: their turn holds the thread.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("person"),
          threadId: THREAD,
          messageId: MessageId.make("message:person"),
          text: "And the tests?",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "auto",
          createdBy: "user",
          creationSource: "web",
        });
        yield* settle;
        assert.lengthOf(turnsOf(THREAD), 2, "the person's turn runs");
        yield* service.reconcile();
        assert.equal(engine.attempts.get("att-plan")!.state, "completed");
        assert.deepInclude(engine.attempts.get("att-plan")!.result!, {
          model: RAN,
          harness: "codex",
        });
        thread = (yield* orchestrator.getThreadProjection(THREAD)).thread;
        assert.equal(thread.worktreePath, cwd, "held while the person's turn runs");
        yield* answer(turnsOf(THREAD)[1]!, "Next the tests.");
        yield* settle;
        // The engine lists no finished attempt: what is owed is read from the thread alone.
        yield* service.reconcile();
        yield* settle;
        thread = (yield* orchestrator.getThreadProjection(THREAD)).thread;
        assert.isNull(thread.worktreePath);
        assert.equal(thread.runtimeMode, "full-access");
      }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-real-give-back-")));
      yield* body.pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("cancels a stage turn still queued behind the brief", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const engine = board();
      const { cwd, layer } = yield* harness("board-execution-real-stop", engine);
      const step = { task: "task-7", worktree: cwd, harness: "codex", model: "test-model" };
      engine.queueAttempt({
        ...step,
        id: "att-plan",
        stage: "plan",
        kind: "team-plan",
        seat: "lead",
        lead: true,
      });
      engine.queueAttempt({ ...step, id: "att-build", stage: "build", kind: "build", seat: "dev" });
      const body = Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* createThread;
        const service = yield* execution();
        yield* service.reconcile();
        yield* worker.drain();
        const runOf = (messageId: MessageId) =>
          orchestrator
            .getThreadProjection(THREAD)
            .pipe(
              Effect.map((projection) =>
                projection.runs.find((run) => run.userMessageId === messageId),
              ),
            );
        assert.equal((yield* runOf(stageMessageId("att-build")))?.status, "queued");
        assert.notEqual((yield* runOf(briefMessageId("att-plan")))?.status, "queued");
        engine.cancelAttempt("att-build");
        yield* service.reconcile();
        yield* worker.drain();
        // A queued turn is cancelled, never interrupted, which the orchestrator refuses; so no
        // child of it ever starts.
        assert.equal((yield* runOf(stageMessageId("att-build")))?.status, "cancelled");
        yield* service.reconcile();
        assert.equal(engine.attempts.get("att-build")!.state, "cancelled");
        // Nothing ran it, so it is told no model or harness.
        assert.isNull(engine.attempts.get("att-build")!.result?.model);
        assert.isNull(engine.attempts.get("att-build")!.result?.harness);
      }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-real-stop-")));
      yield* body.pipe(Effect.provide(layer));
    }),
  ),
);
