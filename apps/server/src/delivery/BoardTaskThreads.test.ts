import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { limitedLeadHandoffThreadId } from "@t3tools/shared/limitedSeat";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import { OrchestratorCommandRejectedError } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BoardConversation from "./BoardConversation.ts";
import { steerMessageId } from "./BoardConversation.ts";
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
import * as LimitedSeats from "./LimitedSeats.ts";
import * as LimitedSeatSwap from "./LimitedSeatSwap.ts";

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
  revision: number;
}

/**
 * What the thread store keeps across a server restart: threads, command receipts, and the
 * committed events with their global sequence, the messages they hold and the runs still active.
 */
function threadStore() {
  const threads = new Map<string, StoredThread>();
  const receipts = new Set<string>();
  const commands: Array<OrchestrationV2ServerCommand> = [];
  const hooks: { afterCreate: (() => void) | null } = { afterCreate: null };
  const events: Array<OrchestrationV2StoredEvent> = [];
  const messages = new Map<string, Set<string>>();
  const active = new Map<string, string>();
  const latestRuns = new Map<string, RunId>();
  const rejects = new Set<string>();
  const commit = (threadId: string, type: string, payload: Record<string, unknown>) =>
    events.push({
      sequence: events.length + 1,
      commandId: null,
      event: {
        type,
        threadId,
        occurredAt: DateTime.makeUnsafe(Date.parse("2026-11-22T10:00:00.000Z") + events.length),
        payload,
      },
    } as unknown as OrchestrationV2StoredEvent);
  /** A user message, complete, and the run it starts. */
  const say = (threadId: string, id: string, text: string, createdBy = "user") => {
    messages.set(threadId, (messages.get(threadId) ?? new Set()).add(id));
    commit(threadId, "message.updated", {
      id,
      role: "user",
      text,
      streaming: false,
      runId: null,
      createdBy,
    });
    active.set(threadId, `run:${id}`);
  };
  /** The active run's reply, streamed then complete, and the run's completion. */
  const reply = (threadId: string, text: string) => {
    const runId = active.get(threadId)!;
    const message = { id: `reply:${runId}`, role: "assistant", runId, createdBy: "agent" };
    commit(threadId, "message.updated", { ...message, text: text.slice(0, 5), streaming: true });
    commit(threadId, "message.updated", { ...message, text, streaming: false });
    commit(threadId, "run.updated", { id: runId, status: "completed" });
    active.delete(threadId);
  };
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    Effect.suspend(
      (): Effect.Effect<
        { readonly storedEvents: ReadonlyArray<never> },
        BoardTaskThreads.BoardTaskThreadsError | OrchestratorCommandRejectedError
      > => {
        commands.push(command);
        // A command already answered is answered again with what it did the first time.
        if (receipts.has(command.commandId)) return Effect.succeed({ storedEvents: [] });
        if (command.type === "message.dispatch") {
          if (rejects.has(command.messageId))
            return Effect.fail(
              new OrchestratorCommandRejectedError({
                commandId: command.commandId,
                commandType: command.type,
              }),
            );
          receipts.add(command.commandId);
          say(command.threadId, command.messageId, command.text, command.createdBy);
        }
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
            revision: 0,
          });
          receipts.add(command.commandId);
          const after = hooks.afterCreate;
          hooks.afterCreate = null;
          after?.();
        }
        if (command.type === "thread.archive") {
          const thread = threads.get(command.threadId)!;
          thread.archivedAt = "2026-11-22T11:00:00.000Z";
          thread.revision += 1;
          receipts.add(command.commandId);
        }
        if (command.type === "thread.unarchive") {
          const thread = threads.get(command.threadId)!;
          thread.archivedAt = null;
          thread.revision += 1;
          receipts.add(command.commandId);
        }
        return Effect.succeed({ storedEvents: [] });
      },
    );
  /** A person restores an archived thread from the board's archive. */
  const restore = (threadId: ThreadId) =>
    dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make(`person:restore:${threads.get(threadId)!.revision}`),
      threadId,
    });
  return {
    threads,
    commands,
    hooks,
    dispatch,
    restore,
    events,
    messages,
    active,
    latestRuns,
    rejects,
    say,
    reply,
  };
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
  return Effect.gen(function* () {
    const conversation = yield* BoardConversation.make;
    return yield* BoardTaskThreads.make.pipe(
      Effect.provideService(BoardConversation.BoardConversation, conversation),
      Effect.provide(LimitedSeatSwap.layer.pipe(Layer.provide(LimitedSeats.layer))),
      Effect.provideService(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
        get: () => Effect.die("A resumed hand-off keeps the successor's model"),
        list: () => Effect.succeed([]),
      }),
    );
  }).pipe(
    Effect.provideService(EventStore.EventStoreV2, {
      read: (input?: { readonly threadId?: string; readonly afterSequence?: number }) =>
        Stream.fromIterable(
          store.events.filter(
            (stored) =>
              stored.event.threadId === input?.threadId &&
              stored.sequence > (input?.afterSequence ?? 0),
          ),
        ),
    } as unknown as EventStore.EventStoreV2["Service"]),
    Effect.provideService(
      HostProcess.Environment,
      options.key === null
        ? {}
        : {
            [DeliveryService.BOARD_THREAD_KEY_VARIABLE]:
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
      findThread: (threadId: string) => {
        const thread = store.threads.get(threadId);
        return Effect.succeed(thread === undefined ? null : { ...thread, deletedAt: null });
      },
      getThreadShell: (threadId: string) => {
        const thread = store.threads.get(threadId);
        return Effect.succeed(
          thread === undefined
            ? null
            : {
                id: threadId,
                latestRunId: store.latestRuns.get(threadId) ?? null,
                latestUserAuthoredMessageAt:
                  store.events.findLast(
                    ({ event }) =>
                      event.threadId === threadId &&
                      event.type === "message.updated" &&
                      event.payload.createdBy === "user",
                  )?.event.occurredAt ?? null,
                modelSelection: thread.modelSelection,
                archivedAt: thread.archivedAt,
              },
        );
      },
      getThreadRecords: (threadId: string) =>
        Effect.succeed({
          thread: {
            lineage: { engineIntake: store.threads.get(threadId)?.marker },
            archivedAt: store.threads.get(threadId)?.archivedAt ?? null,
            modelSelection: store.threads.get(threadId)?.modelSelection,
          },
          runs: store.active.has(threadId) ? [{ id: store.active.get(threadId) }] : [],
        }),
      getMessagesById: (threadId: string, ids: ReadonlyArray<string>) =>
        Effect.succeed(
          new Map(
            store.events.flatMap(({ event }) =>
              event.threadId === threadId &&
              event.type === "message.updated" &&
              ids.includes(event.payload.id)
                ? [[event.payload.id, { id: event.payload.id, createdAt: event.occurredAt }]]
                : [],
            ),
          ),
        ),
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
                    revision: thread.revision,
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

it.effect("keeps a relink to the old board lead with a newer user turn", () => {
  const engine = board();
  engine.addTask({ id: "task-7" });
  const store = threadStore();
  const failedRun = RunId.make("failed-board-lead");
  const successor = limitedLeadHandoffThreadId(failedRun);
  return Effect.gen(function* () {
    const threads = yield* service(store);
    yield* threads.reconcile();
    const [create] = creates(store);
    if (create?.type !== "thread.create") throw new Error("Expected the board lead to open");
    store.latestRuns.set(THREAD, failedRun);
    yield* store.dispatch({
      ...create,
      commandId: CommandId.make("create-successor"),
      threadId: successor,
    });
    store.say(successor, `limited-lead:${THREAD}:${failedRun}:continue`, "Continue", "agent");
    engine.writeLink("task-7", {
      environmentId: ENVIRONMENT,
      threadId: successor,
      setBy: ENVIRONMENT,
    });
    engine.writeLink("task-7", {
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      setBy: ENVIRONMENT,
    });
    // A queued turn can leave the usage-limited run as the latest run in the shell.
    store.say(THREAD, "m-newer", "Continue here");
    const before = puts(engine).length;
    yield* threads.reconcile();
    assert.equal(engine.linkOf("task-7")?.threadId, THREAD);
    assert.lengthOf(puts(engine), before);
    assert.isNull(store.threads.get(THREAD)!.archivedAt);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-swap-relink-")));
});

it.effect.each(["picked", "legacy"] as const)(
  "binds and links a started task on the %s lead model",
  (source) => {
    const engine = board();
    engine.addTask({
      id: "task-7",
      title: "Ship the thing",
      ...(source === "picked"
        ? { seatModels: { lead: { harness: "claude", model: "claude-sonnet", source } } }
        : {}),
    });
    engine.addTask({ id: "draft-1", lane: "draft", state: "draft", submitted: false });
    engine.addTask({ id: "queued-1", lane: "queue", state: "ready" });
    engine.addTask({ id: "done-1", lane: "completed", state: "completed" });
    // A split parent stands where its parts stand, and its parts are the work.
    engine.addTask({ id: "whole-1", lane: "child-work", state: "split" });
    engine.addTask({ id: "whole-2", lane: "in-work", state: "split" });
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
      assert.deepEqual(
        { ...create.modelSelection },
        source === "picked"
          ? { instanceId: "claudeAgent", model: "claude-sonnet" }
          : { instanceId: "codex", model: "gpt-6-astra" },
      );
      const link = engine.linkOf("task-7");
      assert.deepEqual(
        { environmentId: link?.environmentId, threadId: link?.threadId, setBy: link?.setBy },
        { environmentId: ENVIRONMENT, threadId: THREAD, setBy: ENVIRONMENT },
      );
      const put = engine.requests.find((request) => request.method === "PUT");
      assert.deepInclude(put?.body, { expect: null });
      // The claim names the conversation that holds the task, and the next pass is its heartbeat.
      assert.equal(engine.leaseOf("task-7")?.origin, `thread:${ENVIRONMENT}/${THREAD}`);
      // The claim opts the task into the engine holding QA for the lead's hand-off.
      const claim = engine.requests.find((request) => request.path.endsWith("/claim"));
      assert.deepInclude(claim?.body, { handoffs: ["qa"] });
      engine.advance(100_000);
      yield* threads.reconcile();
      engine.advance(100_000);
      assert.isNotNull(engine.leaseOf("task-7"));
      // A second pass made nothing new and wrote nothing new.
      assert.equal(creates(store).length, 1);
      assert.equal(linkWrites(engine).length, 1);
    }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-create-")));
  },
);

it.effect("links every task when a seat has no model yet or one card cannot be read", () => {
  const engine = board();
  const unpicked = { harness: "codex", model: null, source: "profile" };
  engine.addTask({
    id: "task-7",
    seatModels: {
      lead: { harness: "claude", model: "claude-sonnet", source: "picked" },
      "qa-validate": unpicked,
    },
  });
  // A lead with no model yet runs on its roster model, as when the engine serves no picks.
  engine.addTask({ id: "task-8", seatModels: { lead: unpicked } });
  engine.addTask({ id: "task-9" });
  // A pick this build cannot read is no pick.
  engine.addTask({
    id: "task-10",
    seatModels: { lead: { harness: "claude", model: "m", source: "unheard-of" } },
  });
  engine.addTask({ id: "task-bad", served: { set: 7 } });
  const store = threadStore();
  const threadOf = (id: string) => boardTaskThreadId(boardTaskOf("work", id)!);
  return Effect.gen(function* () {
    const threads = yield* service(store);
    assert.deepEqual([...(yield* threads.reconcile())], []);
    assert.deepEqual(
      ["task-7", "task-8", "task-9", "task-10", "task-bad"].map((id) => ({
        id,
        linked: engine.linkOf(id)?.threadId ?? null,
        model: store.threads.get(threadOf(id))?.modelSelection ?? null,
      })),
      [
        {
          id: "task-7",
          linked: threadOf("task-7"),
          model: { instanceId: "claudeAgent", model: "claude-sonnet" },
        },
        {
          id: "task-8",
          linked: threadOf("task-8"),
          model: { instanceId: "codex", model: "gpt-6-astra" },
        },
        {
          id: "task-9",
          linked: threadOf("task-9"),
          model: { instanceId: "codex", model: "gpt-6-astra" },
        },
        {
          id: "task-10",
          linked: threadOf("task-10"),
          model: { instanceId: "codex", model: "gpt-6-astra" },
        },
        { id: "task-bad", linked: null, model: null },
      ],
    );
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-unpicked-seat-")));
});

it.effect("keeps holding a linked task over fields it cannot read, until it leaves work", () => {
  const engine = board();
  const unread = engine.addTask({ id: "task-7" });
  const unlisted = engine.addTask({ id: "task-8" });
  const whole = engine.addTask({ id: "task-9" });
  const store = threadStore();
  const threadOf = (id: string) => boardTaskThreadId(boardTaskOf("work", id)!);
  return Effect.gen(function* () {
    const threads = yield* service(store);
    yield* threads.reconcile();
    unread.seatModels = { lead: { harness: "codex", model: "m", source: "future-source" } };
    unread.served = { hold: { stage: "qa", deadline: "later", handoff: "declined" } };
    store.say(THREAD, "m-1", "Build it", "system");
    store.reply(THREAD, "Done");
    engine.queueSteer("task-7", "Please continue");
    // A split parent holds no claim: its parts are the work.
    whole.state = "split";
    for (let pass = 0; pass < 5; pass++) {
      engine.advance(30_000);
      yield* threads.reconcile();
    }
    assert.isNotNull(engine.leaseOf("task-7"));
    assert.isAbove(engine.activityOf("task-7").length, 0);
    assert.isTrue(steerSends(store).some((send) => send.threadId === THREAD));
    assert.isNull(engine.leaseOf("task-9"));
    assert.isNull(store.threads.get(threadOf("task-9"))!.archivedAt);
    // A card it cannot read is judged from the task's detail: another conversation holds it.
    unlisted.served = { set: 7 };
    engine.writeLink("task-8", { environmentId: OTHER, threadId: "successor", setBy: OTHER });
    yield* threads.reconcile();
    assert.isNotNull(store.threads.get(threadOf("task-8"))!.archivedAt);
    assert.isNull(store.threads.get(THREAD)!.archivedAt);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-unread-linked-")));
});

it.effect(
  "archives the old board lead as displaced only after its successor takes the link",
  () => {
    const engine = board();
    engine.addTask({ id: "task-7" });
    const store = threadStore();
    const failedRun = RunId.make("failed-board-lead");
    const successor = limitedLeadHandoffThreadId(failedRun);
    return Effect.gen(function* () {
      const threads = yield* service(store);
      yield* threads.reconcile();
      const [create] = creates(store);
      if (create?.type !== "thread.create") throw new Error("Expected the board lead to open");
      store.latestRuns.set(THREAD, failedRun);
      yield* store.dispatch({
        ...create,
        commandId: CommandId.make("create-successor"),
        threadId: successor,
      });
      const withoutKey = yield* service(store, { key: null });
      yield* withoutKey.reconcile();
      assert.isNull(store.threads.get(successor)!.archivedAt);
      const previous = engine.linkOf("task-7");
      const moved = engine.handle("PUT", "/api/tasks/task-7/board-thread", {
        key: engine.key,
        environmentId: ENVIRONMENT,
        threadId: successor,
        setBy: ENVIRONMENT,
        expect: previous,
      });
      assert.equal(moved?.status, 200);
      engine.advance(120_001);
      yield* threads.reconcile();
      assert.equal(engine.leaseOf("task-7")?.origin, `thread:${ENVIRONMENT}/${successor}`);
      assert.isTrue(
        store.messages.get(successor)?.has(`limited-lead:${THREAD}:${failedRun}:continue`),
      );
      assert.deepInclude(store.commands.at(-1), {
        type: "thread.archive",
        threadId: THREAD,
        commandId: CommandId.make(`${create.engineIntake}:archive:displaced:0`),
      });
      assert.isNotNull(store.threads.get(THREAD)!.archivedAt);
      assert.isNull(store.threads.get(successor)!.archivedAt);
    }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-swap-")));
  },
);

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

it.effect("retries a dropped board lead link move during reconciliation", () => {
  const engine = board();
  engine.addTask({ id: "task-7" });
  const store = threadStore();
  const failedRun = RunId.make("failed-board-lead");
  const successor = limitedLeadHandoffThreadId(failedRun);
  return Effect.gen(function* () {
    const threads = yield* service(store);
    const delivery = yield* DeliveryService.DeliveryService;
    yield* threads.reconcile();
    const [create] = creates(store);
    if (create?.type !== "thread.create") throw new Error("Expected the board lead to open");
    store.latestRuns.set(THREAD, failedRun);
    yield* store.dispatch({
      ...create,
      commandId: CommandId.make("create-successor"),
      threadId: successor,
    });
    const path = "/api/tasks/task-7/board-thread";
    const previous = engine.linkOf("task-7");
    const body = {
      environmentId: ENVIRONMENT,
      threadId: successor,
      setBy: ENVIRONMENT,
      expect: previous,
      key: engine.key,
    };
    engine.dropNext(/\/api\/tasks\/task-7\/board-thread$/);
    const failed = yield* delivery
      .boardThreadAct({ method: "PUT", path, body })
      .pipe(Effect.result);
    assert.equal(failed._tag, "Failure");
    assert.equal(engine.linkOf("task-7")?.threadId, THREAD);
    assert.isNull(store.threads.get(THREAD)!.archivedAt);

    const holder = engine.leaseOf("task-7")?.holder;
    yield* threads.reconcile();

    assert.deepEqual(puts(engine).at(-1), { method: "PUT", path, body });
    assert.equal(engine.linkOf("task-7")?.threadId, successor);
    assert.isDefined(holder);
    assert.equal(engine.leaseOf("task-7")?.holder, holder);
    assert.isTrue(
      store.messages.get(successor)?.has(`limited-lead:${THREAD}:${failedRun}:continue`),
    );
    assert.deepInclude(store.commands.at(-1), {
      type: "thread.archive",
      threadId: THREAD,
      commandId: CommandId.make(`${create.engineIntake}:archive:displaced:0`),
    });
    assert.isNotNull(store.threads.get(THREAD)!.archivedAt);
    assert.isNull(store.threads.get(successor)!.archivedAt);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-swap-retry-")));
});

it.effect("starts the successor once after a restart between its create and first turn", () => {
  const engine = board();
  engine.addTask({ id: "task-7" });
  const store = threadStore();
  const failedRun = RunId.make("failed-board-lead");
  const successor = limitedLeadHandoffThreadId(failedRun);
  const messageId = `limited-lead:${THREAD}:${failedRun}:continue`;
  return Effect.gen(function* () {
    yield* (yield* service(store)).reconcile();
    const [create] = creates(store);
    if (create?.type !== "thread.create") throw new Error("Expected the board lead to open");
    store.latestRuns.set(THREAD, failedRun);
    yield* store.dispatch({
      ...create,
      commandId: CommandId.make("create-successor"),
      threadId: successor,
    });
    assert.isFalse(store.messages.has(successor));
    const restarted = yield* service(store);
    yield* restarted.reconcile();
    assert.equal(engine.linkOf("task-7")?.threadId, successor);
    assert.isTrue(store.messages.get(successor)?.has(messageId));
    yield* restarted.reconcile();
    const turns = store.commands.filter(
      (command) => command.type === "message.dispatch" && command.threadId === successor,
    );
    assert.lengthOf(turns, 1);
    assert.deepInclude(turns[0], {
      commandId: CommandId.make(messageId),
      messageId: MessageId.make(messageId),
    });
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-swap-restart-")));
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
    // A person restores the displaced thread. The task is still another conversation's, so the
    // next pass archives it again, each time it is restored: it never sits open in no list.
    for (const restored of [1, 2]) {
      yield* store.restore(THREAD);
      assert.isNull(store.threads.get(THREAD)!.archivedAt);
      yield* threads.reconcile();
      assert.isNotNull(store.threads.get(THREAD)!.archivedAt, `restore ${restored}`);
    }
    assert.equal(engine.linkOf("task-7")?.threadId, THEIRS);
    assert.equal(puts(engine).length, 1);
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
    // Restored while the task is still on the other machine. The lanes no longer list it, so
    // the task's own detail is what says it moved: the thread holds nothing and is archived
    // again, each time it is restored, on this server and on a new one after a restart.
    engine.task("task-7").state = "moved";
    for (const pass of [threads, yield* service(store)]) {
      yield* store.restore(THREAD);
      assert.isNull(store.threads.get(THREAD)!.archivedAt);
      assert.deepEqual([...(yield* pass.reconcile())], []);
      assert.isNotNull(store.threads.get(THREAD)!.archivedAt);
      assert.deepEqual(engine.requests.at(-1), {
        method: "GET",
        path: "/api/tasks/task-7",
        body: undefined,
      });
    }
    assert.equal(puts(engine).length, 1);
    // The task came back and its link is free: restoring the thread is what links it, on the
    // next pass, and it is the task's conversation from then on.
    engine.task("task-7").state = "running";
    assert.deepEqual([...(yield* threads.reconcile())], [["task-7", "archived-thread"]]);
    yield* store.restore(THREAD);
    assert.deepEqual([...(yield* threads.reconcile())], []);
    assert.equal(engine.linkOf("task-7")?.threadId, THREAD);
    assert.equal(engine.linkOf("task-7")?.environmentId, ENVIRONMENT);
    assert.isNotNull(engine.leaseOf("task-7"));
    yield* threads.reconcile();
    assert.isNull(store.threads.get(THREAD)!.archivedAt);
    assert.equal(store.threads.size, 1);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-moved-")));
});

it.effect(
  "archives a moved task's thread once its link is gone, and keeps one it still holds",
  () => {
    const engine = board();
    engine.addTask({ id: "task-7" });
    engine.addTask({ id: "task-8" });
    engine.addTask({ id: "task-9" });
    const store = threadStore();
    const threadOf = (id: string) => boardTaskThreadId(boardTaskOf("work", id)!);
    return Effect.gen(function* () {
      const threads = yield* service(store);
      yield* threads.reconcile();
      // Three linked tasks leave this machine. One lost its link first, one keeps it, and one is
      // still on its way, which the lanes go on listing.
      engine.handle("DELETE", "/api/tasks/task-7/board-thread", { key: engine.key });
      engine.task("task-7").state = "moved";
      engine.task("task-8").state = "moved";
      engine.task("task-9").state = "moving";
      yield* threads.reconcile();
      assert.isNotNull(store.threads.get(THREAD)!.archivedAt);
      // A thread its moved task still names stays the task's conversation, and claims nothing.
      for (const id of ["task-8", "task-9"]) {
        assert.isNull(store.threads.get(threadOf(id))!.archivedAt, id);
        assert.equal(engine.linkOf(id)?.threadId, threadOf(id));
        assert.isNull(engine.leaseOf(id), id);
      }
      assert.isNull(engine.leaseOf("task-7"));
      // A forced restore of the moved task's thread cannot leave it open in no list.
      yield* store.restore(THREAD);
      yield* threads.reconcile();
      assert.isNotNull(store.threads.get(THREAD)!.archivedAt);
    }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-moved-away-")));
  },
);

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
      // A person restores the deleted task's thread. Its task is gone, so no list would show it
      // and the board's archive no longer would either: the next pass archives it again, on this
      // server and on a new one after a restart, however often it is restored.
      yield* store.restore(THREAD);
      assert.isNull(store.threads.get(THREAD)!.archivedAt);
      yield* threads.reconcile();
      assert.isNotNull(store.threads.get(THREAD)!.archivedAt);
      yield* store.restore(THREAD);
      yield* (yield* service(store)).reconcile();
      assert.isNotNull(store.threads.get(THREAD)!.archivedAt);
      // A pass repeated over an archived thread sends no further archive.
      const archives = () =>
        store.commands.filter((command) => command.type === "thread.archive").length;
      const sent = archives();
      yield* threads.reconcile();
      assert.equal(archives(), sent);
      assert.isNull(store.threads.get(finished)!.archivedAt);
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
      "/api/tasks/task-7/activity",
      "/api/tasks/task-7/steers/1/delivered",
      "/api/tasks/task-7/lead-pick",
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
    const pick = yield* delivery
      .boardThreadAct({ method: "POST", path: "/api/tasks/task-7/lead-pick", body: {} })
      .pipe(Effect.result);
    assert.equal(pick._tag === "Failure" ? pick.failure.status : null, 404);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-act-")));
});

const ingests = (engine: ScratchEngine) =>
  engine.requests.filter((request) => request.path.endsWith("/activity")).length;
const steerSends = (store: ThreadStore) =>
  store.commands.filter((command) => command.type === "message.dispatch");

it.effect("mirrors each conversation event once, across a restart and a replaced thread", () => {
  const engine = board();
  engine.addTask({ id: "task-7" });
  const store = threadStore();
  return Effect.gen(function* () {
    const first = yield* service(store);
    yield* first.reconcile();
    store.say(THREAD, "m-1", "Build the  thing\nplease", "system");
    store.reply(THREAD, "x".repeat(300));
    store.say(THREAD, "m-2", "a person's words", "user");
    yield* first.reconcile();
    // Each seq is the event store's own; a streamed reply counts once, when its run completes. A
    // person's words are a steer with no excerpt, so they never reach the card.
    assert.deepEqual(
      engine.activityOf("task-7").map((row) => [row.seq, row.kind, row.excerpt, row.setBy]),
      [
        [1, "message", "Build the thing please", ENVIRONMENT],
        [4, "summary", `${"x".repeat(199)}…`, ENVIRONMENT],
        [5, "steer", null, ENVIRONMENT],
      ],
    );
    yield* first.reconcile();
    assert.equal(ingests(engine), 3);
    // A restarted server starts from the engine's highest seq and sends nothing it already has.
    const after = yield* service(store);
    yield* after.reconcile();
    assert.equal(ingests(engine), 3);
    // A replacing conversation's events come later in the one sequence, so no seq is reused.
    const replacement = ThreadId.make("board-task:work:task-7:replacement");
    engine.writeLink("task-7", {
      environmentId: ENVIRONMENT,
      threadId: replacement,
      setBy: ENVIRONMENT,
    });
    store.say(replacement, "m-3", "Start again", "system");
    yield* after.reconcile();
    assert.deepEqual(
      engine.activityOf("task-7").map((row) => row.seq),
      [1, 4, 5, 6],
    );
    const delivery = yield* DeliveryService.DeliveryService;
    yield* delivery.boardThreadAct({
      method: "POST",
      path: "/api/tasks/task-7/activity",
      body: {
        seq: 7,
        at: "2026-11-23T00:00:00.000Z",
        kind: "message",
        setBy: "previous-environment",
        key: engine.key,
      },
    });
    store.say(replacement, "m-4", "From a separate sequence", "system");
    store.say(replacement, "m-5", "Another event after transfer", "system");
    const beforeTransfer = ingests(engine);
    yield* (yield* service(store)).reconcile();
    assert.equal(ingests(engine), beforeTransfer);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-mirror-")));
});

it.effect("tells the lead once per QA entry when its hand-off is awaited", () => {
  const engine = board();
  const task = engine.addTask({ id: "task-7", run: { id: "run-1" } });
  const store = threadStore();
  return Effect.gen(function* () {
    const threads = yield* service(store);
    const firstDeadline = "2026-11-22T10:30:00.000Z";
    const reworkDeadline = "2026-11-22T11:00:00.000Z";
    for (const { hold, noticeCount } of [
      { hold: null, noticeCount: 0 },
      { hold: { stage: "qa", deadline: firstDeadline, handoff: "handed" }, noticeCount: 0 },
      { hold: { stage: "qa", deadline: firstDeadline, handoff: null }, noticeCount: 1 },
      { hold: { stage: "qa", deadline: reworkDeadline, handoff: null }, noticeCount: 2 },
    ] as const) {
      task.hold = hold;
      yield* threads.reconcile();
      yield* threads.reconcile();
      assert.lengthOf(steerSends(store), noticeCount);
    }
    const [first, rework] = steerSends(store);
    assert.include(first?.text, firstDeadline);
    assert.include(rework?.text, reworkDeadline);
    assert.match(String(first?.text), /delivery_seat_handoff/);
    assert.notEqual(first?.messageId, rework?.messageId);
    assert.notEqual(first?.commandId, rework?.commandId);
    task.seatModels = { lead: { harness: "codex", model: "gpt-6-sol", source: "picked" } };
    task.hold = { stage: "qa", deadline: "2026-11-22T11:30:00.000Z", handoff: null };
    yield* threads.reconcile();
    assert.lengthOf(steerSends(store), 3);
    assert.deepEqual(steerSends(store)[2]?.modelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-sol",
    });
    task.hold = { stage: "qa", deadline: "2026-11-22T12:00:00.000Z", handoff: null };
    engine.dropNext(/^\/api\/tasks\/task-7$/);
    yield* threads.reconcile();
    assert.lengthOf(steerSends(store), 4);
    assert.include(steerSends(store)[3]?.text, task.hold.deadline);
    assert.isUndefined(steerSends(store)[3]?.modelSelection);
    yield* threads.reconcile();
    assert.lengthOf(steerSends(store), 4);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-handoff-notice-")));
});

const ownSeqs = (engine: ScratchEngine) =>
  engine
    .activityOf("task-7")
    .filter((row) => row.setBy === ENVIRONMENT)
    .map((row) => row.seq);

it.effect("mirrors beside another environment on a scoped engine, from its own floor", () => {
  const engine = board({ sourceScoped: true });
  engine.addTask({ id: "task-7" });
  const store = threadStore();
  return Effect.gen(function* () {
    const first = yield* service(store);
    yield* first.reconcile();
    engine.writeLink("task-7", { environmentId: OTHER, threadId: THEIRS, setBy: OTHER });
    engine.ingestFrom("task-7", { seq: 1, setBy: OTHER });
    engine.ingestFrom("task-7", { seq: 90, setBy: OTHER });
    engine.writeLink("task-7", {
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      setBy: ENVIRONMENT,
    });
    store.say(THREAD, "m-1", "One", "system");
    store.say(THREAD, "m-2", "Two", "system");
    yield* (yield* service(store)).reconcile();
    assert.deepEqual(ownSeqs(engine), [1, 2]);
    // The same seq from two sources is kept twice.
    assert.deepEqual(
      engine
        .activityOf("task-7")
        .filter((row) => row.seq === 1)
        .map((row) => row.setBy)
        .toSorted(),
      [ENVIRONMENT, OTHER].toSorted(),
    );
    // A restarted server resumes from its own entry in the floors (2), never the other's (90).
    store.say(THREAD, "m-3", "Three", "system");
    const before = ingests(engine);
    yield* (yield* service(store)).reconcile();
    assert.deepEqual(ownSeqs(engine), [1, 2, 3]);
    assert.equal(ingests(engine), before + 1);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-scoped-")));
});

it.effect("stays paused beside another source on an older engine, then resumes", () => {
  const engine = board();
  engine.addTask({ id: "task-7" });
  const store = threadStore();
  return Effect.gen(function* () {
    const threads = yield* service(store);
    yield* threads.reconcile();
    engine.ingestFrom("task-7", { seq: 7, setBy: OTHER });
    store.say(THREAD, "m-1", "One", "system");
    // Without the marker the other source's row would be taken for this one's floor.
    yield* threads.reconcile();
    yield* threads.reconcile();
    assert.equal(ingests(engine), 0);
    // The engine is installed under the running server: the pause lifts, from no floor.
    engine.setSourceScoped(true);
    yield* threads.reconcile();
    assert.deepEqual(ownSeqs(engine), [1]);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-paused-")));
});

it.effect.each([
  { harness: "codex", model: "gpt-6-sol", follows: true },
  { harness: "claude", model: "claude-sonnet", follows: false },
  { harness: "codex", model: null, follows: false },
])(
  "delivers and confirms a queued steer when the published model is $model",
  ({ harness, model, follows }) => {
    const engine = board();
    engine.addTask({ id: "task-7" });
    const store = threadStore();
    return Effect.gen(function* () {
      const threads = yield* service(store);
      yield* threads.reconcile();
      engine.task("task-7").seatModels = { lead: { harness, model, source: "picked" } };
      store.say(THREAD, "m-1", "Build it", "system");
      const steer = engine.queueSteer("task-7", "Use the other API");
      yield* threads.reconcile();
      // The running turn is never interrupted: the steer waits, pending.
      assert.equal(steerSends(store).length, 0);
      assert.equal(engine.steer(steer).state, "pending");
      store.reply(THREAD, "Done");
      // The confirmation is lost on the way, after the steer reached the conversation.
      engine.dropNext(/\/steers\/\d+\/delivered$/);
      yield* threads.reconcile();
      assert.equal(steerSends(store).length, 1);
      assert.deepInclude(steerSends(store)[0], {
        threadId: THREAD,
        messageId: steerMessageId(TASK, steer),
        text: "Use the other API",
        dispatchMode: { type: "queue_after_active" },
      });
      assert.deepEqual(
        steerSends(store)[0]?.modelSelection,
        follows && model !== null
          ? { instanceId: ProviderInstanceId.make("codex"), model }
          : undefined,
      );
      assert.equal(engine.steer(steer).state, "pending");
      // A restarted server confirms it from the conversation and never sends it twice.
      const after = yield* service(store);
      yield* after.reconcile();
      yield* after.reconcile();
      assert.equal(steerSends(store).length, 1);
      assert.equal(engine.steer(steer).state, "delivered");
      assert.deepInclude(engine.activityOf("task-7").at(-1), { kind: "steer", excerpt: null });
    }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-steer-")));
  },
);

it.effect(
  "keeps a steer pending while its conversation is archived, and tells a refusal failed",
  () => {
    const engine = board();
    engine.addTask({ id: "task-7" });
    const store = threadStore();
    return Effect.gen(function* () {
      const threads = yield* service(store);
      yield* threads.reconcile();
      const steer = engine.queueSteer("task-7", "Stop and ask first");
      store.threads.get(THREAD)!.archivedAt = "2026-11-22T11:00:00.000Z";
      yield* threads.reconcile();
      assert.equal(steerSends(store).length, 0);
      assert.equal(engine.steer(steer).state, "pending");
      yield* store.restore(THREAD);
      store.rejects.add(steerMessageId(TASK, steer));
      yield* threads.reconcile();
      assert.deepInclude(engine.steer(steer), { state: "failed" });
      assert.match(engine.steer(steer).failure ?? "", /rejected/);
      // A failed steer is settled for good: it is not sent again.
      yield* threads.reconcile();
      assert.equal(steerSends(store).length, 1);
    }).pipe(Effect.provide(deliveryLayer(engine, "board-threads-steer-failed-")));
  },
);
