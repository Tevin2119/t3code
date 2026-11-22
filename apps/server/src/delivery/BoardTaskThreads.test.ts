import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BoardTaskThreads from "./BoardTaskThreads.ts";
import {
  scratchEngine,
  scratchEngineHttp,
  type ScratchEngine,
} from "./boardThreadEngine.testkit.ts";
import * as BoardThreadRows from "./boardThreadRows.ts";
import {
  boardTaskOf,
  boardTaskOfMarker,
  boardTaskThreadCommandId,
  boardTaskThreadId,
} from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";

// Every case here runs against the scratch engine of boardThreadEngine.testkit.ts, through the
// delivery service's real request path. BoardTaskThreads.engine.test.ts runs the real engine.

const ENVIRONMENT = EnvironmentId.make("471fea73-5365-4bbb-96eb-8e35be50eaec");
const OTHER = "0d9b2f0e-other-environment";
const REPO = "/work/repo";
const PROJECT = ProjectId.make("project:repo");
const TEAMS = [
  {
    team: "development",
    seats: [
      { seat: "developer", role: "lead-developer", harness: "claude", model: "claude-fable-5-1" },
      { seat: "lead", role: "team-lead", harness: "codex", model: "gpt-6-astra" },
    ],
  },
];

interface StoredThread {
  readonly commandId: string;
  readonly projectId: string;
  readonly title: string;
  readonly modelSelection: unknown;
  readonly marker: string | undefined;
  archivedAt: string | null;
}

/** What the thread store keeps across a server restart: threads and command receipts. */
function threadStore() {
  const threads = new Map<string, StoredThread>();
  const receipts = new Set<string>();
  const commands: Array<OrchestrationV2ServerCommand> = [];
  const hooks: { afterCreate: (() => void) | null } = { afterCreate: null };
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    Effect.suspend(() => {
      commands.push(command);
      // A command already answered is answered again with what it did the first time.
      if (receipts.has(command.commandId)) return Effect.succeed({ storedEvents: [] });
      if (command.type === "thread.create") {
        if (threads.has(command.threadId))
          return Effect.fail(new BoardTaskThreads.BoardTaskThreadsError({ reason: "thread" }));
        threads.set(command.threadId, {
          commandId: command.commandId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          marker: command.engineIntake,
          archivedAt: null,
        });
        receipts.add(command.commandId);
        const after = hooks.afterCreate;
        hooks.afterCreate = null;
        after?.();
      }
      if (command.type === "thread.archive") {
        threads.get(command.threadId)!.archivedAt = "2026-11-22T11:00:00.000Z";
        receipts.add(command.commandId);
      }
      if (command.type === "thread.unarchive") {
        threads.get(command.threadId)!.archivedAt = null;
        receipts.add(command.commandId);
      }
      return Effect.succeed({ storedEvents: [] });
    });
  return { threads, commands, hooks, dispatch };
}
type ThreadStore = ReturnType<typeof threadStore>;

const INSTANCES = [
  { instanceId: "codex", driverKind: "codex", enabled: true },
  { instanceId: "claudeAgent", driverKind: "claudeAgent", enabled: true },
];

function service(
  store: ThreadStore,
  options: {
    readonly key?: string | null;
    readonly instances?: ReadonlyArray<(typeof INSTANCES)[number]>;
    readonly projects?: ReadonlyArray<string>;
  } = {},
) {
  return BoardTaskThreads.make.pipe(
    Effect.provideService(
      HostProcess.Environment,
      options.key === null
        ? {}
        : {
            [BoardTaskThreads.BOARD_THREAD_KEY_VARIABLE]:
              options.key ?? "scratch approval passphrase",
          },
    ),
    Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(ENVIRONMENT),
    }),
    Effect.provideService(ThreadManagementService.ThreadManagementService, {
      dispatch: store.dispatch,
    } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    Effect.provideService(ProjectionStore.ProjectionStoreV2, {
      getThreadRecords: (threadId: string) =>
        Effect.succeed({
          thread: {
            lineage: { engineIntake: store.threads.get(threadId)?.marker },
            archivedAt: store.threads.get(threadId)?.archivedAt ?? null,
          },
        }),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
    Effect.provideService(ProjectStore.ProjectStoreV2, {
      findActiveByWorkspaceRoot: (root: string) =>
        Effect.succeed(
          (options.projects ?? [REPO]).includes(root)
            ? Option.some({ projectId: PROJECT })
            : Option.none(),
        ),
    } as unknown as ProjectStore.ProjectStoreV2["Service"]),
    Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      listInstances: Effect.succeed(options.instances ?? INSTANCES),
    } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]),
    Effect.provideService(BoardThreadRows.BoardThreadRows, {
      list: ({ archived }: { readonly archived: boolean }) =>
        Effect.succeed(
          [...store.threads].flatMap(([threadId, thread]) => {
            const task = boardTaskOfMarker(thread.marker);
            return task === null || (thread.archivedAt !== null) !== archived
              ? []
              : [
                  {
                    threadId: ThreadId.make(threadId),
                    projectId: PROJECT,
                    title: thread.title,
                    archivedAt: thread.archivedAt,
                    task,
                    pullRequests: null,
                    issues: null,
                  },
                ];
          }),
        ),
    }),
  );
}

/** The delivery service as the server runs it, with the scratch engine behind its HTTP client. */
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

function board(options: Parameters<typeof scratchEngine>[0] = {}) {
  const engine = scratchEngine(options);
  engine.setBoard("work", REPO);
  engine.setTeams(TEAMS);
  return engine;
}

const TASK = boardTaskOf("work", "task-7")!;
const THREAD = boardTaskThreadId(TASK);
const THEIRS = "thread:their/board-task:a:b%3Ac";
const creates = (store: ThreadStore) =>
  store.commands.filter((command) => command.type === "thread.create");
const puts = (engine: ScratchEngine) =>
  engine.requests.filter((request) => request.method === "PUT");
const linkWrites = (engine: ScratchEngine) =>
  engine.events.filter((event) => event.kind === "task.board-thread-set");

it.effect("gives a started task one thread, led as the engine's team says, and links it", () => {
  const engine = board();
  engine.addTask({ id: "task-7", title: "Ship the thing" });
  engine.addTask({ id: "draft-1", lane: "draft", state: "draft", submitted: false });
  engine.addTask({ id: "queued-1", lane: "queue", state: "ready" });
  engine.addTask({ id: "done-1", lane: "completed", state: "completed" });
  const store = threadStore();
  return Effect.gen(function* () {
    const threads = yield* service(store);
    assert.deepEqual([...(yield* threads.reconcile())], []);
    // Only the task the engine says is in work has a thread.
    assert.deepEqual([...store.threads.keys()], [THREAD]);
    const [create] = creates(store);
    assert.equal(create?.type, "thread.create");
    if (create?.type !== "thread.create") return;
    assert.equal(create.commandId, boardTaskThreadCommandId(TASK));
    assert.equal(create.projectId, PROJECT);
    assert.equal(create.title, "Ship the thing");
    assert.deepEqual(boardTaskOfMarker(create.engineIntake), TASK);
    // The lead is the seat the engine's team names as its lead, on that seat's harness and model.
    assert.deepEqual({ ...create.modelSelection }, { instanceId: "codex", model: "gpt-6-astra" });
    const link = engine.linkOf("task-7");
    assert.deepEqual(
      { environmentId: link?.environmentId, threadId: link?.threadId, setBy: link?.setBy },
      { environmentId: ENVIRONMENT, threadId: THREAD, setBy: ENVIRONMENT },
    );
    const put = engine.requests.find((request) => request.method === "PUT");
    assert.deepInclude(put?.body, { expect: null });
    // The claim names the conversation that holds the task, and the next pass is its heartbeat.
    assert.equal(engine.leaseOf("task-7")?.origin, `thread:${ENVIRONMENT}/${THREAD}`);
    engine.advance(100_000);
    yield* threads.reconcile();
    engine.advance(100_000);
    assert.isNotNull(engine.leaseOf("task-7"));
    // A second pass made nothing new and wrote nothing new.
    assert.equal(creates(store).length, 1);
    assert.equal(linkWrites(engine).length, 1);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-create-")));
});

it.effect("makes one thread when a task is started twice and by two servers at once", () => {
  const engine = board();
  engine.addTask({ id: "task-7" });
  const store = threadStore();
  return Effect.gen(function* () {
    const first = yield* service(store);
    const second = yield* service(store);
    yield* Effect.all(
      [first.reconcile(), first.reconcile(), second.reconcile(), second.reconcile()],
      { concurrency: "unbounded" },
    );
    assert.deepEqual([...store.threads.keys()], [THREAD]);
    assert.equal(linkWrites(engine).length, 1);
    assert.equal(engine.linkOf("task-7")?.threadId, THREAD);
    assert.isNull(store.threads.get(THREAD)!.archivedAt);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-double-")));
});

it.effect("finishes the link after a restart between the create and the engine write", () => {
  const engine = board();
  engine.addTask({ id: "task-7" });
  const store = threadStore();
  return Effect.gen(function* () {
    // The server stops answering right after the thread exists: the link is never written.
    store.hooks.afterCreate = () => engine.setDown(true);
    const before = yield* service(store);
    const failed = yield* before.reconcile().pipe(Effect.result);
    assert.equal(failed._tag, "Failure");
    assert.deepEqual([...store.threads.keys()], [THREAD]);
    assert.isNull(engine.linkOf("task-7"));
    // A new server process: nothing in memory, the same stored thread and receipts.
    engine.setDown(false);
    const after = yield* service(store);
    yield* after.reconcile();
    assert.deepEqual([...store.threads.keys()], [THREAD]);
    assert.equal(creates(store).length, 2);
    assert.equal(engine.linkOf("task-7")?.threadId, THREAD);
    assert.equal(linkWrites(engine).length, 1);
    // The claim of the process that died lapses, and the same thread holds the task again.
    engine.advance(121_000);
    yield* after.reconcile();
    assert.equal(engine.leaseOf("task-7")?.origin, `thread:${ENVIRONMENT}/${THREAD}`);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-restart-")));
});

it.effect("adopts the link another writer set first and never overwrites it", () => {
  const engine = board();
  engine.addTask({ id: "task-7" });
  const store = threadStore();
  return Effect.gen(function* () {
    engine.beforeNextPut(() => {
      engine.writeLink("task-7", { environmentId: OTHER, threadId: THEIRS, setBy: OTHER });
    });
    const threads = yield* service(store);
    yield* threads.reconcile();
    // The engine's value is read back after the refusal and stands as it was written: a thread id
    // of another environment keeps its colons, slash and percent sign.
    assert.deepEqual(
      engine.requests.slice(-2).map((request) => `${request.method} ${request.path}`),
      ["PUT /api/tasks/task-7/board-thread", "GET /api/tasks/task-7"],
    );
    assert.equal(engine.linkOf("task-7")?.threadId, THEIRS);
    assert.equal(engine.linkOf("task-7")?.setBy, OTHER);
    // The thread made here holds no task: it is archived, not deleted, and claims nothing.
    assert.isNotNull(store.threads.get(THREAD)!.archivedAt);
    assert.isNull(engine.leaseOf("task-7"));
    yield* threads.reconcile();
    assert.equal(engine.linkOf("task-7")?.threadId, THEIRS);
    assert.equal(linkWrites(engine).length, 1);
    assert.equal(engine.requests.filter((request) => request.method === "PUT").length, 1);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-conflict-")));
});

it.effect("makes no thread for a moved task, and archives one the engine refuses as moved", () => {
  const engine = board();
  engine.addTask({ id: "moved-1", state: "moved" });
  engine.addTask({ id: "task-7" });
  const store = threadStore();
  return Effect.gen(function* () {
    // The task moves to another machine after the lanes were read and before the link is written.
    store.hooks.afterCreate = () => {
      engine.task("task-7").state = "moved";
    };
    const threads = yield* service(store);
    const holds = yield* threads.reconcile();
    assert.deepEqual([...holds], [["task-7", "moved"]]);
    assert.deepEqual([...store.threads.keys()], [THREAD]);
    assert.isNotNull(store.threads.get(THREAD)!.archivedAt);
    assert.isNull(engine.linkOf("task-7"));
    assert.isNull(engine.leaseOf("task-7"));
    // The task that had already moved was never given a thread or a write.
    assert.isFalse(engine.requests.some((request) => request.path.includes("moved-1")));
    // The refusal is final: a later pass that sees the task in work, on this server or on a new
    // one after a restart, writes nothing while the thread stays archived.
    engine.task("task-7").state = "running";
    assert.deepEqual([...(yield* threads.reconcile())], [["task-7", "archived-thread"]]);
    assert.deepEqual(
      [...(yield* (yield* service(store)).reconcile())],
      [["task-7", "archived-thread"]],
    );
    assert.equal(puts(engine).length, 1);
    assert.isNull(engine.linkOf("task-7"));
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-moved-")));
});

it.effect("archives the thread of a task the engine no longer has, and never asks again", () => {
  const engine = board();
  engine.addTask({ id: "task-7" });
  const store = threadStore();
  return Effect.gen(function* () {
    // The task is deleted after the lanes were read and before the link is written.
    store.hooks.afterCreate = () => engine.removeTask("task-7");
    const threads = yield* service(store);
    assert.deepEqual([...(yield* threads.reconcile())], []);
    assert.isNotNull(store.threads.get(THREAD)!.archivedAt);
    assert.equal(puts(engine).length, 1);
    engine.addTask({ id: "task-7" });
    assert.deepEqual(
      [...(yield* (yield* service(store)).reconcile())],
      [["task-7", "archived-thread"]],
    );
    assert.equal(puts(engine).length, 1);
    assert.isNull(engine.linkOf("task-7"));
    assert.equal(store.threads.size, 1);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-not-found-")));
});

it.effect("sends the engine one link write at a time, however many tasks have no link", () => {
  const engine = board();
  const ids = Array.from({ length: 12 }, (_, index) => `task-${index}`);
  for (const id of ids) engine.addTask({ id });
  const store = threadStore();
  return Effect.gen(function* () {
    const threads = yield* service(store);
    yield* Effect.all([threads.reconcile(), threads.reconcile(), threads.reconcile()], {
      concurrency: "unbounded",
    });
    assert.equal(engine.linkWrites.most, 1);
    assert.equal(puts(engine).length, ids.length);
    assert.deepEqual(
      ids.map((id) => engine.linkOf(id)?.threadId),
      ids.map((id) => boardTaskThreadId(boardTaskOf("work", id)!)),
    );
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-queue-")));
});

it.effect("refuses a board id with a colon at write, and links a thread id that has them", () => {
  const engine = board();
  engine.setBoard("team:alpha", REPO);
  engine.addTask({ id: "t1", set: "team:alpha" });
  engine.addTask({ id: "task-7" });
  const store = threadStore();
  return Effect.gen(function* () {
    const threads = yield* service(store);
    // No thread, no command and no write for the id the marker cannot carry.
    assert.deepEqual([...(yield* threads.reconcile())], [["t1", "unmarkable-id"]]);
    assert.deepEqual([...store.threads.keys()], [THREAD]);
    assert.isFalse(engine.requests.some((request) => request.path.includes("/t1/")));
    // The thread id T3 writes carries two colons, and the engine takes it as it is.
    assert.equal(THREAD.split(":").length, 3);
    assert.equal(engine.linkOf("task-7")?.threadId, THREAD);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-colon-")));
});

it.effect("says why a started task has no thread instead of falling back to a default", () => {
  const cases = [
    {
      hold: "no-lead",
      teams: [{ team: "development", seats: [{ seat: "qa", role: "qa", harness: "kimi" }] }],
    },
    {
      hold: "no-lead-model",
      teams: [
        { team: "development", seats: [{ seat: "lead", role: "team-lead", harness: "codex" }] },
      ],
    },
    {
      hold: "no-provider",
      teams: [
        {
          team: "development",
          seats: [{ seat: "lead", role: "team-lead", harness: "hermes", model: "m" }],
        },
      ],
    },
    {
      hold: "ambiguous-provider",
      instances: [
        { instanceId: "codex-work", driverKind: "codex", enabled: true },
        { instanceId: "codex-home", driverKind: "codex", enabled: true },
      ],
    },
    { hold: "no-project", projects: [] },
  ] as const;
  return Effect.forEach(cases, (entry) => {
    const engine = board();
    engine.addTask({ id: "task-7" });
    if ("teams" in entry) engine.setTeams(entry.teams);
    const store = threadStore();
    return Effect.gen(function* () {
      const threads = yield* service(store, {
        ...("instances" in entry ? { instances: entry.instances } : {}),
        ...("projects" in entry ? { projects: entry.projects } : {}),
      });
      assert.deepEqual([...(yield* threads.reconcile())], [["task-7", entry.hold]]);
      assert.equal(store.threads.size, 0);
      assert.isNull(engine.linkOf("task-7"));
    }).pipe(Effect.provide(deliveryLayer(engine, `board-threads-${entry.hold}-`)));
  });
});

it.effect("writes no link without the approval key, and none on a wrong one", () => {
  const engine = board();
  engine.addTask({ id: "task-7" });
  const store = threadStore();
  return Effect.gen(function* () {
    const keyless = yield* service(store, { key: null });
    assert.deepEqual([...(yield* keyless.reconcile())], [["task-7", "no-key"]]);
    // Nothing is sent: a keyless write would count against a person's approval attempts.
    assert.isFalse(engine.requests.some((request) => request.method === "PUT"));
    const wrong = yield* service(store, { key: "not the passphrase" });
    assert.deepEqual([...(yield* wrong.reconcile())], [["task-7", "refused"]]);
    assert.isNull(engine.linkOf("task-7"));
    assert.isNull(store.threads.get(THREAD)!.archivedAt);
    const keyed = yield* service(store);
    assert.deepEqual([...(yield* keyed.reconcile())], []);
    assert.equal(engine.linkOf("task-7")?.threadId, THREAD);
    assert.equal(store.threads.size, 1);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-key-")));
});

it.effect(
  "archives the thread of a task that was deleted, and leaves a finished task's open",
  () => {
    const engine = board();
    engine.addTask({ id: "task-7" });
    engine.addTask({ id: "task-8" });
    const store = threadStore();
    return Effect.gen(function* () {
      const threads = yield* service(store);
      yield* threads.reconcile();
      const finished = boardTaskThreadId(boardTaskOf("work", "task-8")!);
      engine.task("task-8").lane = "completed";
      engine.task("task-8").state = "completed";
      engine.removeTask("task-7");
      yield* threads.reconcile();
      assert.isNotNull(store.threads.get(THREAD)!.archivedAt);
      // A finished task keeps its conversation where the task view reads it; its slot is freed.
      assert.isNull(store.threads.get(finished)!.archivedAt);
      assert.equal(engine.linkOf("task-8")?.threadId, finished);
      assert.isNull(engine.leaseOf("task-8"));
      // A person restored the archived thread from the board: it is not archived a second time.
      store.threads.get(THREAD)!.archivedAt = null;
      yield* threads.reconcile();
      assert.isNull(store.threads.get(THREAD)!.archivedAt);
    }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-ended-")));
  },
);

it.effect("makes nothing on an engine that serves no board thread link", () => {
  const engine = board({ servesLink: false });
  engine.addTask({ id: "task-7" });
  const store = threadStore();
  return Effect.gen(function* () {
    const threads = yield* service(store);
    assert.deepEqual([...(yield* threads.reconcile())], []);
    assert.equal(store.threads.size, 0);
    assert.deepEqual(
      engine.requests.map((request) => request.method),
      ["GET"],
    );
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-old-engine-")));
});

it.effect("keeps the link and claim routes for the server: a client's act is refused", () => {
  const engine = board();
  engine.addTask({ id: "task-7" });
  return Effect.gen(function* () {
    const delivery = yield* DeliveryService.DeliveryService;
    for (const path of [
      "/api/tasks/task-7/board-thread",
      "/api/orchestration/tasks/task-7/claim",
      "/api/orchestration/tasks/task-7/release",
    ]) {
      const refused = yield* delivery.act({ path, body: { key: engine.key } }).pipe(Effect.result);
      assert.equal(refused._tag, "Failure");
    }
    assert.deepEqual(engine.requests, []);
    // The server's own clear is answered 204 with no body, whether or not a link was set.
    const cleared = yield* delivery.boardThreadAct({
      method: "DELETE",
      path: "/api/tasks/task-7/board-thread",
      body: { key: engine.key, setBy: ENVIRONMENT },
    });
    assert.isNull(cleared.body);
    const unknown = yield* delivery
      .boardThreadAct({
        method: "DELETE",
        path: "/api/tasks/no-such-task/board-thread",
        body: { key: engine.key, setBy: ENVIRONMENT },
      })
      .pipe(Effect.result);
    assert.equal(unknown._tag === "Failure" ? unknown.failure.status : null, 404);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-act-")));
});
