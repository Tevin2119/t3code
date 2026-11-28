import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import { scratchEngine, scratchEngineHttp } from "./boardThreadEngine.testkit.ts";
import * as BoardTaskSideChats from "./BoardTaskSideChats.ts";
import { sideChatKey } from "./BoardTaskSideChats.ts";
import {
  boardTaskOf,
  boardTaskThreadCommandId,
  boardTaskThreadId,
  createBoardTaskThread,
} from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";

// A side chat of a board task's thread is recorded on its task in the engine through the
// delivery service's real keyed request path, against the scratch engine's related-thread routes.

const ENVIRONMENT = EnvironmentId.make("471fea73-5365-4bbb-96eb-8e35be50eaec");
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("No turn runs in this case"),
};
const TASK = boardTaskOf("work", "task-9")!;
const TASK_THREAD = boardTaskThreadId(TASK);
const SIDE_CHAT = ThreadId.make("task-9-side-chat");

function setup(options: Parameters<typeof scratchEngine>[0] = {}) {
  const engine = scratchEngine(options);
  engine.addTask({ id: TASK.id });
  const database = SqlitePersistence.layerMemory;
  const orchestration = ProviderReplayHarness.layerWithRegistry(
    { name: "board-task-side-chats" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false, databaseLayer: database },
  ).pipe(Layer.provideMerge(database));
  const delivery = Layer.fresh(DeliveryService.layer(deriveProviderInstanceConfigMap)).pipe(
    Layer.provideMerge(ServerSecretStore.layer.pipe(Layer.provide(SecureRandom.layerWebCrypto))),
    Layer.provideMerge(Layer.succeed(HostProcess.Environment, {})),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "board-side-chats-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      ServerSettings.layerTest({ delivery: { enabled: true, engineUrl: "http://127.0.0.1:4320" } }),
    ),
    Layer.provideMerge(scratchEngineHttp(engine)),
  );
  const layer = Layer.mergeAll(orchestration, delivery).pipe(
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(ENVIRONMENT),
      } as ServerEnvironment.ServerEnvironmentIdentity["Service"]),
    ),
  );
  const service = BoardTaskSideChats.make.pipe(
    Effect.provideServiceEffect(
      DeliveryService.DeliveryService,
      Effect.gen(function* () {
        const live = yield* DeliveryService.DeliveryService;
        return { ...live, boardApprovalKey: Effect.succeed(engine.key) };
      }),
    ),
  );
  return { engine, layer, service };
}

const openTaskThreadAndSideChat = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch(
    createBoardTaskThread(TASK, {
      commandId: boardTaskThreadCommandId(TASK),
      threadId: TASK_THREAD,
      projectId: ProjectId.make("board-task-side-chats-project"),
      title: "Fix the sync",
      modelSelection: { instanceId, model: "test-model" },
    }),
  );
  yield* orchestrator.dispatch({
    type: "thread.fork",
    commandId: CommandId.make("task-9-discuss"),
    sourceThreadId: TASK_THREAD,
    targetThreadId: SIDE_CHAT,
    sourcePoint: { type: "latest_stable" },
    title: "Side chat",
    sideChat: true,
    createdBy: "user",
    creationSource: "web",
  });
  return orchestrator;
});

const relatedEvents = (engine: ReturnType<typeof scratchEngine>) =>
  engine.events.filter((event) => event.kind.startsWith("task.related-thread-"));

it.effect("a side chat is put on its task once, however often it is recorded", () => {
  const { engine, layer, service } = setup();
  return Effect.gen(function* () {
    yield* openTaskThreadAndSideChat;
    const sideChats = yield* service;
    yield* sideChats.record(SIDE_CHAT);
    // A second write of the same value, as a retry or a restart sends it, changes nothing.
    yield* sideChats.record(SIDE_CHAT);

    const key = sideChatKey(ENVIRONMENT, SIDE_CHAT);
    assert.deepStrictEqual(
      engine.relatedOf(TASK.id).map(({ setAt: _, ...link }) => link),
      [{ key, environmentId: ENVIRONMENT, threadId: SIDE_CHAT, role: "side", setBy: ENVIRONMENT }],
    );
    assert.lengthOf(relatedEvents(engine), 1);
    const puts = engine.requests.filter((request) => request.method === "PUT");
    assert.lengthOf(puts, 2);
    assert.strictEqual(puts[0]!.path, `/api/tasks/${TASK.id}/threads/${key}`);
    // The task thread itself is never related to its own task.
    assert.notInclude(
      engine.relatedOf(TASK.id).map((link) => link.threadId),
      TASK_THREAD,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("a put lost on the way is made by the board's next pass, and only once", () => {
  const { engine, layer, service } = setup();
  return Effect.gen(function* () {
    yield* openTaskThreadAndSideChat;
    const sideChats = yield* service;
    engine.dropNext(/\/threads\//);
    yield* sideChats.record(SIDE_CHAT);
    assert.deepStrictEqual(engine.relatedOf(TASK.id), []);

    const pass = () =>
      sideChats.sync({
        cards: new Map([
          [
            TASK.id,
            { state: engine.task(TASK.id).state, relatedThreads: engine.relatedOf(TASK.id) },
          ],
        ]),
        environmentId: ENVIRONMENT,
        key: engine.key,
      });
    yield* pass();
    assert.deepStrictEqual(
      engine.relatedOf(TASK.id).map((link) => link.threadId),
      [SIDE_CHAT],
    );
    const writes = engine.requests.length;
    // A card that already lists it is not written to again.
    yield* pass();
    assert.strictEqual(engine.requests.length, writes);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "archiving a side chat removes its link and restoring it puts it back; the task stays",
  () => {
    const { engine, layer, service } = setup();
    return Effect.gen(function* () {
      const orchestrator = yield* openTaskThreadAndSideChat;
      const sideChats = yield* service;
      yield* sideChats.record(SIDE_CHAT);
      const before = { ...engine.task(TASK.id) };

      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("task-9-side-chat-archive"),
        threadId: SIDE_CHAT,
      });
      yield* sideChats.record(SIDE_CHAT);
      assert.deepStrictEqual(engine.relatedOf(TASK.id), []);
      assert.deepStrictEqual(engine.task(TASK.id), before);

      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("task-9-side-chat-restore"),
        threadId: SIDE_CHAT,
      });
      yield* sideChats.record(SIDE_CHAT);
      assert.deepStrictEqual(
        engine.relatedOf(TASK.id).map((link) => link.threadId),
        [SIDE_CHAT],
      );

      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("task-9-side-chat-close"),
        threadId: SIDE_CHAT,
        onlyIfUnused: true,
      });
      yield* sideChats.record(SIDE_CHAT);
      assert.deepStrictEqual(engine.relatedOf(TASK.id), []);
      assert.deepStrictEqual(engine.task(TASK.id), before);
      assert.deepStrictEqual(
        relatedEvents(engine).map((event) => event.kind),
        [
          "task.related-thread-set",
          "task.related-thread-cleared",
          "task.related-thread-set",
          "task.related-thread-cleared",
        ],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("an engine before related threads is never written to by the pass", () => {
  const { engine, layer, service } = setup({ servesRelated: false });
  return Effect.gen(function* () {
    yield* openTaskThreadAndSideChat;
    const sideChats = yield* service;
    yield* sideChats.sync({
      cards: new Map([[TASK.id, { state: "running" }]]),
      environmentId: ENVIRONMENT,
      key: engine.key,
    });
    assert.deepStrictEqual(
      engine.requests.filter((request) => request.method !== "GET"),
      [],
    );
  }).pipe(Effect.provide(layer));
});
