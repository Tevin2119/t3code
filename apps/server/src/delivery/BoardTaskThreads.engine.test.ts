// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off globalJsonInEffect:off - Drives a real engine process over HTTP; the raw calls are the evidence.
// BoardTaskThreads against a real delivery engine, not the scratch one of
// boardThreadEngine.testkit.ts. Skipped unless T3_BOARD_THREAD_ENGINE_ROOT names a checkout of
// the engine (Operation-PaperClip) that serves the task-to-thread contract; last validated at
// its commit a658892b:
//
//   mkdir /tmp/engine-a658892b
//   git -C <Operation-PaperClip> archive a658892b delivery teams | tar -x -C /tmp/engine-a658892b
//   cd apps/server && T3_BOARD_THREAD_ENGINE_ROOT=/tmp/engine-a658892b \
//     vp test run src/delivery/BoardTaskThreads.engine.test.ts
//
// The test starts scripts/board-thread-engine.ts, which serves that engine from a temp home with
// one bound repository and one board, and stops it at the end. Real: the engine, its store, its
// HTTP API, the delivery service's request path, and BoardTaskThreads. Stubbed: T3's own thread
// store (commands are kept in memory, with command receipts), the project lookup, the provider
// registry (codex and claudeAgent enabled), and the board thread rows read. No provider runs.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BoardConversation from "./BoardConversation.ts";
import * as BoardTaskThreads from "./BoardTaskThreads.ts";
import * as BoardThreadRows from "./boardThreadRows.ts";
import { boardTaskOf, boardTaskOfMarker, boardTaskThreadId } from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";

const ENGINE_ROOT = process.env.T3_BOARD_THREAD_ENGINE_ROOT ?? "";
// Scratch values: the engine is seeded with this passphrase and nothing else knows it.
const PHRASE = NodeCrypto.randomBytes(24).toString("hex");
const ENVIRONMENT = EnvironmentId.make("8f6f2c1e-0000-4000-8000-this-environment");
const OTHER = "0d9b2f0e-other-environment";
const PROJECT = ProjectId.make("project:repo");
const SUBMITTED = "2026-11-22T05:00:00.000Z";

interface Engine {
  readonly engine: string;
  readonly control: string;
  readonly repo: string;
}

/** The real engine, started for this test and stopped with its temp folder when the scope ends. */
const startEngine = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<Engine & { readonly child: NodeChildProcess.ChildProcess }>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [
            NodePath.resolve(import.meta.dirname, "../../scripts/board-thread-engine.ts"),
            ENGINE_ROOT,
          ],
          {
            env: { ...process.env, T3_BOARD_THREAD_ENGINE_PHRASE: PHRASE },
            stdio: ["ignore", "pipe", "inherit"],
          },
        );
        let out = "";
        child.stdout!.on("data", (chunk) => {
          out += String(chunk);
          const line = out.split("\n").find((entry) => entry.startsWith("{"));
          if (line && out.includes("\n")) resolve({ ...(JSON.parse(line) as Engine), child });
        });
        child.once("exit", (code) => reject(new Error(`the engine exited with ${code}`)));
        child.once("error", reject);
      }),
  ),
  (engine) =>
    Effect.promise(async () => {
      await fetch(`${engine.control}/stop`, { method: "POST" }).catch(() => undefined);
      engine.child.kill();
    }),
);

/** The model the engine's team configuration gives the development team's lead seat. */
const leadModel = (): string => {
  const team = JSON.parse(
    NodeFS.readFileSync(NodePath.join(ENGINE_ROOT, "teams/development/team.json"), "utf8"),
  ) as { seats: ReadonlyArray<{ id: string; model: string }> };
  return team.seats.find((seat) => seat.id === "lead")!.model;
};

// Set once the engine is up; every helper below reads them when called.
let ENGINE = "";
let CONTROL = "";
let REPO = "";

const json = (url: string, init?: RequestInit) =>
  Effect.promise(async () => {
    const response = await fetch(url, init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null } as {
      status: number;
      body: any;
    };
  });
const control = (path: string, body: unknown) =>
  json(`${CONTROL}${path}`, { method: "POST", body: JSON.stringify(body) }).pipe(
    Effect.map((answer) => answer.body),
  );
const engineGet = (path: string) => json(`${ENGINE}${path}`).pipe(Effect.map((a) => a.body));
const enginePut = (path: string, body: unknown) =>
  json(`${ENGINE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const add = (over: Record<string, unknown> = {}) =>
  control("/add", { state: "triage", submitted: SUBMITTED, ...over }).pipe(
    Effect.map((task) => task.id as string),
  );
const linkOf = (id: string) => engineGet(`/api/tasks/${id}`).pipe(Effect.map((t) => t.boardThread));
const setEvents = (id: string) =>
  control("/events", { id }).pipe(
    Effect.map((events: Array<{ kind: string }>) =>
      events.filter((event) => event.kind === "task.board-thread-set"),
    ),
  );
const leaseOf = (id: string) =>
  engineGet("/api/orchestration").pipe(
    Effect.map((snapshot) => snapshot.holders.find((holder: any) => holder.task === id) ?? null),
  );

function threadStore() {
  const threads = new Map<
    string,
    {
      marker: string | undefined;
      title: string;
      modelSelection: unknown;
      archivedAt: string | null;
      revision: number;
    }
  >();
  const receipts = new Set<string>();
  const commands: Array<OrchestrationV2ServerCommand> = [];
  const hooks: { afterCreate: ((threadId: string) => Effect.Effect<unknown>) | null } = {
    afterCreate: null,
  };
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    Effect.gen(function* () {
      commands.push(command);
      if (receipts.has(command.commandId)) return { storedEvents: [] };
      receipts.add(command.commandId);
      if (command.type === "thread.create") {
        threads.set(command.threadId, {
          marker: command.engineIntake,
          title: command.title,
          modelSelection: command.modelSelection,
          archivedAt: null,
          revision: 0,
        });
        const after = hooks.afterCreate;
        if (after) yield* after(command.threadId);
      }
      // Every event of a thread raises its revision, as the event stream's version does.
      if (command.type === "thread.archive" || command.type === "thread.unarchive") {
        const thread = threads.get(command.threadId)!;
        thread.archivedAt = command.type === "thread.archive" ? "archived" : null;
        thread.revision += 1;
      }
      return { storedEvents: [] };
    });
  /** A person restores an archived thread from the board's archive. */
  const restore = (threadId: ThreadId) =>
    dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make(`person:restore:${threadId}:${threads.get(threadId)!.revision}`),
      threadId,
    });
  return { threads, commands, hooks, dispatch, restore };
}

function service(store: ReturnType<typeof threadStore>, key: string | null = PHRASE) {
  return BoardTaskThreads.make.pipe(
    // The conversation mirror is proven against the scratch engine in BoardTaskThreads.test.ts.
    Effect.provideService(BoardConversation.BoardConversation, { sync: () => Effect.void }),
    Effect.provideService(
      HostProcess.Environment,
      key === null ? {} : { [BoardTaskThreads.BOARD_THREAD_KEY_VARIABLE]: key },
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
        Effect.succeed(root === REPO ? Option.some({ projectId: PROJECT }) : Option.none()),
    } as unknown as ProjectStore.ProjectStoreV2["Service"]),
    Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      listInstances: Effect.succeed([
        { instanceId: "codex", driverKind: "codex", enabled: true },
        { instanceId: "claudeAgent", driverKind: "claudeAgent", enabled: true },
      ]),
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
                    revision: thread.revision,
                    task,
                    pullRequests: null,
                    issues: null,
                  },
                ];
          }),
        ),
    } as unknown as BoardThreadRows.BoardThreadRows["Service"]),
  );
}

const realHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.promise(async () => {
      const body =
        request.body._tag === "Uint8Array"
          ? new TextDecoder().decode(request.body.body)
          : undefined;
      const response = await fetch(request.url, {
        method: request.method,
        ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
      });
      return HttpClientResponse.fromWeb(request, response);
    }),
  ),
);
const deliveryLayer = (engineUrl: string) =>
  Layer.fresh(DeliveryService.layer(deriveProviderInstanceConfigMap)).pipe(
    Layer.provideMerge(Layer.succeed(HostProcess.Environment, {})),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "board-threads-real-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettings.layerTest({ delivery: { enabled: true, engineUrl } })),
    Layer.provideMerge(realHttp),
  );
const threadOf = (id: string) => boardTaskThreadId(boardTaskOf("work", id)!);

const linkLife = Effect.gen(function* () {
  const started = yield* add({ title: "Ship the thing" });
  const draft = yield* add({ state: "draft", submitted: null });
  const queued = yield* add({ state: "ready" });
  const done = yield* add({ state: "merged" });
  const store = threadStore();
  const threads = yield* service(store);
  assert.deepEqual([...(yield* threads.reconcile())], []);
  assert.deepEqual([...store.threads.keys()], [threadOf(started)]);
  const create = store.commands.find((command) => command.type === "thread.create");
  assert.deepEqual(create?.type === "thread.create" ? { ...create.modelSelection } : null, {
    instanceId: ProviderInstanceId.make("codex"),
    model: leadModel(),
  });
  const link = yield* linkOf(started);
  assert.deepEqual(
    { environmentId: link.environmentId, threadId: link.threadId, setBy: link.setBy },
    { environmentId: ENVIRONMENT, threadId: threadOf(started), setBy: ENVIRONMENT },
  );
  assert.equal((threadOf(started) as string).split(":").length, 3);
  for (const id of [draft, queued, done]) assert.isNull(yield* linkOf(id));
  const lease = yield* leaseOf(started);
  assert.equal(lease.origin, `thread:${ENVIRONMENT}/${threadOf(started)}`);
  yield* threads.reconcile();
  const renewed = yield* leaseOf(started);
  assert.equal(renewed.claimed, lease.claimed);
  assert.isTrue(renewed.heartbeat >= lease.heartbeat);
  assert.equal((yield* setEvents(started)).length, 1);
  assert.equal(store.commands.filter((command) => command.type === "thread.create").length, 1);

  // Two passes at once and a second server: one thread, one write.
  const twice = yield* add();
  const second = yield* service(store);
  yield* Effect.all([threads.reconcile(), threads.reconcile(), second.reconcile()], {
    concurrency: "unbounded",
  });
  assert.equal((yield* setEvents(twice)).length, 1);
  assert.equal((yield* linkOf(twice)).threadId, threadOf(twice));
  assert.isNull(store.threads.get(threadOf(twice))!.archivedAt);

  // Conflict: another writer links first, with a thread id carrying : / and %.
  const contested = yield* add();
  const theirs = "thread:their/board-task:a:b%3Ac";
  store.hooks.afterCreate = () =>
    enginePut(`/api/tasks/${contested}/board-thread`, {
      environmentId: OTHER,
      threadId: theirs,
      setBy: OTHER,
      key: PHRASE,
    }).pipe(Effect.tap((answer) => Effect.sync(() => assert.equal(answer.status, 200))));
  assert.deepEqual([...(yield* threads.reconcile())], []);
  store.hooks.afterCreate = null;
  const held = yield* linkOf(contested);
  assert.deepEqual([held.environmentId, held.threadId, held.setBy], [OTHER, theirs, OTHER]);
  assert.isNotNull(store.threads.get(threadOf(contested))!.archivedAt);
  assert.equal((yield* setEvents(contested)).length, 1);
  assert.isNull(yield* leaseOf(contested));
  yield* threads.reconcile();
  assert.equal((yield* linkOf(contested)).threadId, theirs);

  // Moved between the lanes read and the write: code moved, archived, never retried.
  const moving = yield* add();
  store.hooks.afterCreate = () => control("/move", { id: moving, state: "moved" });
  assert.deepEqual([...(yield* threads.reconcile())], [[moving, "moved"]]);
  store.hooks.afterCreate = null;
  assert.isNotNull(store.threads.get(threadOf(moving))!.archivedAt);
  assert.isNull(yield* linkOf(moving));
  // The engine lists a moved task in no lane and still answers for it. A forced restore of its
  // thread is archived again on the next pass, from the state its detail gives.
  const lanes = yield* engineGet(BoardTaskThreads.LANES_PATH);
  assert.isFalse(
    lanes.lanes.some((lane: any) => lane.cards.some((card: any) => card.id === moving)),
  );
  assert.equal((yield* engineGet(`/api/tasks/${moving}`)).state, "moved");
  yield* store.restore(threadOf(moving));
  assert.isNull(store.threads.get(threadOf(moving))!.archivedAt);
  assert.deepEqual([...(yield* threads.reconcile())], []);
  assert.isNotNull(store.threads.get(threadOf(moving))!.archivedAt);
  yield* control("/move", { id: moving, state: "triage" });
  assert.deepEqual([...(yield* threads.reconcile())], [[moving, "archived-thread"]]);
  assert.isNull(yield* linkOf(moving));
  assert.equal((yield* setEvents(moving)).length, 0);

  // Deleted between the lanes read and the write: code not-found, archived.
  const vanishing = yield* add();
  store.hooks.afterCreate = () => control("/delete", { id: vanishing });
  assert.deepEqual([...(yield* threads.reconcile())], [[moving, "archived-thread"]]);
  store.hooks.afterCreate = null;
  assert.isNotNull(store.threads.get(threadOf(vanishing))!.archivedAt);

  // Without the approval key nothing is sent to the link route, and the thread waits open.
  const locked = yield* add();
  const keyless = yield* service(store, null);
  assert.deepEqual(
    [...(yield* keyless.reconcile())].toSorted(),
    [
      [locked, "no-key"],
      [moving, "archived-thread"],
    ].toSorted(),
  );
  assert.isNull(yield* linkOf(locked));
  assert.isNull(store.threads.get(threadOf(locked))!.archivedAt);
  assert.equal((yield* setEvents(locked)).length, 0);

  // A wrong key is refused by code, and nothing is written or archived.
  const wrong = yield* service(store, "not the passphrase at all");
  assert.deepEqual(
    [...(yield* wrong.reconcile())].toSorted(),
    [
      [locked, "refused"],
      [moving, "archived-thread"],
    ].toSorted(),
  );
  assert.isNull(yield* linkOf(locked));
  assert.isNull(store.threads.get(threadOf(locked))!.archivedAt);
  assert.deepEqual([...(yield* threads.reconcile())], [[moving, "archived-thread"]]);
  assert.equal((yield* linkOf(locked)).threadId, threadOf(locked));

  // A linked task that is deleted leaves its thread archived.
  yield* control("/delete", { id: started });
  yield* threads.reconcile();
  assert.isNotNull(store.threads.get(threadOf(started))!.archivedAt);
  assert.isNull(store.threads.get(threadOf(twice))!.archivedAt);

  // Restored from the archive with its task still deleted, or still another conversation's: the
  // next pass archives it again, so it never sits open where no list shows it.
  for (const id of [started, contested]) {
    yield* store.restore(threadOf(id));
    assert.isNull(store.threads.get(threadOf(id))!.archivedAt);
    yield* threads.reconcile();
    assert.isNotNull(store.threads.get(threadOf(id))!.archivedAt);
  }
  assert.equal((yield* linkOf(contested)).threadId, theirs);

  // Restored with its task back in work and the link free: the next pass links it.
  yield* store.restore(threadOf(moving));
  assert.deepEqual([...(yield* threads.reconcile())], []);
  const relinked = yield* linkOf(moving);
  assert.deepEqual([relinked.environmentId, relinked.threadId], [ENVIRONMENT, threadOf(moving)]);
  assert.equal((yield* setEvents(moving)).length, 1);
  assert.isNull(store.threads.get(threadOf(moving))!.archivedAt);
});

it.live.skipIf(ENGINE_ROOT === "")("runs the whole link life against the real engine", () =>
  Effect.gen(function* () {
    const engine = yield* startEngine;
    ENGINE = engine.engine;
    CONTROL = engine.control;
    REPO = engine.repo;
    yield* linkLife.pipe(Effect.provide(deliveryLayer(engine.engine)));
  }).pipe(Effect.scoped),
);
