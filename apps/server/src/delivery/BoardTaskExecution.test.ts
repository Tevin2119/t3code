import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2EngineStageSeat,
  type OrchestrationV2Notification,
  type OrchestrationV2ServerCommand,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import { briefMessageId, seatCommandId } from "./boardTaskAttempts.ts";
import * as BoardTaskExecution from "./BoardTaskExecution.ts";
import * as BoardTaskThreads from "./BoardTaskThreads.ts";
import * as BoardThreadRows from "./boardThreadRows.ts";
import {
  scratchEngine,
  scratchEngineHttp,
  type ScratchEngine,
} from "./boardThreadEngine.testkit.ts";
import { boardTaskOf, boardTaskThreadId, boardTaskThreadMarker } from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";

// Every case runs against the scratch engine's model of native attempts v2, through the delivery
// service's real request path, over a thread store that keeps the committed messages, runs,
// provider turns and subagents across a restart of this server. BoardTaskExecution.orchestrator
// .test.ts sends the same commands through the real orchestrator.

const ENVIRONMENT = EnvironmentId.make("471fea73-5365-4bbb-96eb-8e35be50eaec");
const OWNER = `t3-board:${ENVIRONMENT}`;
const TASK = boardTaskOf("work", "task-7")!;
const THREAD = boardTaskThreadId(TASK);
const LEAD = createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-fable-5-1");
const INSTANCES = [
  { instanceId: "codex", driverKind: "codex", enabled: true },
  { instanceId: "claudeAgent", driverKind: "claudeAgent", enabled: true },
];
const childOf = (attemptId: string) => ThreadId.make(`child:${seatCommandId(THREAD, attemptId)}`);

interface StoredRun {
  readonly id: RunId;
  readonly threadId: string;
  readonly userMessageId: MessageId;
  readonly ordinal: number;
  readonly modelSelection: ModelSelection;
  readonly providerInstanceId: string;
  readonly activeAttemptId: string;
  status: string;
}
interface StoredSubagent {
  readonly id: string;
  readonly threadId: string;
  readonly runId: RunId;
  readonly childThreadId: ThreadId;
  readonly title: string;
  readonly driver: string;
  readonly model: string;
  readonly teamChat?: {
    readonly sourceRunId: RunId;
    readonly stage: string;
    readonly seat: string;
  };
  status: string;
  result: string | null;
}

const ACTIVE = ["preparing", "starting", "running", "waiting"];

/** What the thread store keeps across a restart of this server: its commits and receipts. */
function threadStore() {
  const marker = boardTaskThreadMarker(TASK);
  const threads = new Map([
    [
      THREAD as string,
      {
        marker,
        modelSelection: LEAD,
        worktreePath: null as string | null,
        runtimeMode: "full-access",
      },
    ],
  ]);
  const messages: Array<{
    readonly id: MessageId;
    readonly threadId: string;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly runId: RunId | null;
    readonly notification?: OrchestrationV2Notification;
    readonly streaming: false;
  }> = [];
  const runs: Array<StoredRun> = [];
  const subagents: Array<StoredSubagent> = [];
  /** What the provider reported each turn ran on: the only identity a step reports. */
  const providerTurns: Array<{
    readonly threadId: string;
    readonly runAttemptId: string;
    readonly ordinal: number;
    readonly model?: string;
  }> = [];
  const receipts = new Set<string>();
  const commands: Array<OrchestrationV2ServerCommand> = [];
  /** The events the commands committed, in order. */
  const events: Array<{ readonly type: string; readonly id: string }> = [];

  const addRun = (threadId: string, messageId: MessageId, modelSelection: ModelSelection) => {
    // Behind a live turn a new one waits its turn.
    const busy = runs.some((run) => run.threadId === threadId && ACTIVE.includes(run.status));
    // A stage turn waits at its start until NativeTeamChat has started its seats.
    const stage = messages.find((message) => message.id === messageId)?.notification;
    const run = {
      id: RunId.make(`run:${messageId}`),
      threadId,
      userMessageId: messageId,
      ordinal: runs.length + 1,
      modelSelection,
      providerInstanceId: modelSelection.instanceId,
      activeAttemptId: `attempt:${messageId}`,
      status: busy ? "queued" : stage?.source.kind === "engine_stage" ? "starting" : "running",
    };
    runs.push(run);
    return run;
  };

  const dispatch = (command: OrchestrationV2ServerCommand) =>
    Effect.sync(() => {
      commands.push(command);
      // A command already answered is answered again with what it did the first time.
      if (receipts.has(command.commandId)) return { storedEvents: [] };
      receipts.add(command.commandId);
      if (command.type === "message.dispatch") {
        messages.push({
          id: command.messageId,
          threadId: command.threadId,
          role: "user",
          text: command.text,
          runId: null,
          streaming: false,
          ...(command.notification === undefined ? {} : { notification: command.notification }),
        });
        const run = addRun(
          command.threadId,
          command.messageId,
          command.modelSelection ?? threads.get(command.threadId)!.modelSelection,
        );
        events.push({ type: "message.updated", id: command.messageId });
        events.push({ type: "run.created", id: run.id });
      }
      if (command.type === "thread.metadata.update" && command.worktreePath !== undefined)
        threads.get(command.threadId)!.worktreePath = command.worktreePath;
      if (command.type === "thread.runtime-mode.set")
        threads.get(command.threadId)!.runtimeMode = command.runtimeMode;
      if (command.type === "run.interrupt") {
        runs.find((run) => run.id === command.runId)!.status = "interrupted";
        events.push({ type: "run.updated", id: command.runId });
      }
      if (command.type === "queued-run.cancel") {
        runs.find((run) => run.id === command.runId)!.status = "cancelled";
        events.push({ type: "run.updated", id: command.runId });
      }
      if (command.type === "subagent.stop") {
        subagents.find((task) => task.id === command.subagentId)!.status = "cancelled";
        events.push({ type: "subagent.updated", id: command.subagentId });
      }
      return { storedEvents: [] };
    });

  const runOf = (messageId: MessageId) => runs.find((run) => run.userMessageId === messageId)!;
  /** The provider's report of the model a turn runs on. */
  const ranOn = (threadId: string, run: StoredRun, model?: string) =>
    providerTurns.push({
      threadId,
      runAttemptId: run.activeAttemptId,
      ordinal: providerTurns.length + 1,
      ...(model === undefined ? {} : { model }),
    });
  /** The turn's last reply, and its end. */
  const reply = (messageId: MessageId, text: string, status = "completed") => {
    const run = runOf(messageId);
    messages.push({
      id: MessageId.make(`reply:${run.id}`),
      threadId: run.threadId,
      role: "assistant",
      text,
      runId: run.id,
      streaming: false,
    });
    run.status = status;
    events.push({ type: "run.updated", id: run.id });
  };
  /** A person's turn, running in the task thread. */
  const personTurn = (text: string) => {
    const messageId = MessageId.make(`person:${text}`);
    messages.push({
      id: messageId,
      threadId: THREAD,
      role: "user",
      text,
      runId: null,
      streaming: false,
    });
    return addRun(THREAD, messageId, LEAD);
  };
  /** A child's thread, its run, and its answer: what the seat's subagent is made of. */
  const child = (
    task: Omit<StoredSubagent, "status" | "result">,
    status = "running",
    ran?: { readonly model?: string; readonly answer?: string },
  ) => {
    subagents.push({ ...task, status, result: null });
    const run = addRun(
      task.childThreadId,
      MessageId.make(`task:${task.id}`),
      createModelSelection(ProviderInstanceId.make(task.driver), task.model),
    );
    if (ran !== undefined) ranOn(task.childThreadId, run, ran.model);
    events.push({ type: "subagent.updated", id: task.id });
    return run;
  };
  /** The children `NativeTeamChat.prepareTurn` starts for an engine stage's seats. */
  const startSeats = (messageId: MessageId) => {
    const run = runOf(messageId);
    run.status = "starting";
    const message = messages.find((candidate) => candidate.id === messageId)!;
    const source = message.notification?.source;
    if (source?.kind !== "engine_stage") throw new Error("Expected an engine stage");
    for (const seat of source.seats)
      child({
        id: `node:${seat.attemptId}`,
        threadId: run.threadId,
        runId: run.id,
        childThreadId: seat.childThreadId,
        title: `${seat.seat} · ${source.stage}`,
        driver: seat.modelSelection.instanceId === "codex" ? "codex" : "claudeAgent",
        model: seat.modelSelection.model,
      });
    return source.seats;
  };
  /** A child's end, with the model its provider reported running, when it reported one. */
  const finishSeat = (attemptId: string, answer: string, status = "completed", ran?: string) => {
    const task = subagents.find((candidate) => candidate.id === `node:${attemptId}`)!;
    task.status = status;
    task.result = `Result of ${attemptId}`;
    const run = runs.find((candidate) => candidate.threadId === task.childThreadId)!;
    run.status = status;
    ranOn(task.childThreadId, run, ran);
    messages.push({
      id: MessageId.make(`reply:${run.id}`),
      threadId: task.childThreadId,
      role: "assistant",
      text: answer,
      runId: run.id,
      streaming: false,
    });
    events.push({ type: "subagent.updated", id: task.id });
  };
  /** Each message this server sent, once, whatever the replays. */
  const sent = () =>
    [...new Map(commands.map((command) => [command.commandId, command])).values()].flatMap(
      (command) => (command.type === "message.dispatch" ? [command] : []),
    );
  /** The system turns that start an engine stage's seats. */
  const stages = () =>
    sent().flatMap((command) =>
      command.notification?.source.kind === "engine_stage" ? [command.messageId] : [],
    );
  const kinds = (...types: ReadonlyArray<string>) =>
    [...new Map(commands.map((command) => [command.commandId, command])).values()]
      .filter((command) => types.includes(command.type))
      .map((command) => command.type);
  return {
    threads,
    messages,
    runs,
    subagents,
    providerTurns,
    receipts,
    commands,
    events,
    dispatch,
    runOf,
    ranOn,
    reply,
    personTurn,
    child,
    startSeats,
    finishSeat,
    sent,
    stages,
    kinds,
  };
}
type ThreadStore = ReturnType<typeof threadStore>;

/** The board pass's claim of a task, as BoardTaskThreads holds it, on the scratch engine. */
function boardClaims(engine: ScratchEngine) {
  const holders = new Map<string, string>();
  const calls: Array<string> = [];
  const holdTask = (taskId: string, threadId: ThreadId) =>
    Effect.sync(() => {
      calls.push(taskId);
      const held = holders.get(taskId);
      const path = `/api/orchestration/tasks/${taskId}`;
      if (held && engine.handle("POST", `${path}/ack`, { holder: held }).status === 200)
        return true;
      const answer = engine.handle("POST", `${path}/claim`, {
        origin: `thread:${ENVIRONMENT}/${threadId}`,
      });
      if (answer.status !== 200) return false;
      holders.set(taskId, (answer.body as { holder: string }).holder);
      return true;
    });
  return { calls, holdTask };
}

/** One server process: a fresh service over the same store, engine and claims. */
function service(store: ThreadStore, claims: ReturnType<typeof boardClaims>) {
  return BoardTaskExecution.make.pipe(
    Effect.provideService(BoardTaskThreads.BoardTaskThreads, {
      holdTask: claims.holdTask,
    } as unknown as BoardTaskThreads.BoardTaskThreads["Service"]),
    Effect.provideService(HostProcess.Environment, {
      [DeliveryService.BOARD_THREAD_KEY_VARIABLE]: "scratch approval passphrase",
    }),
    Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(ENVIRONMENT),
    }),
    Effect.provideService(ThreadManagementService.ThreadManagementService, {
      dispatch: store.dispatch,
      hasReceipt: (commandId: string) => Effect.sync(() => store.receipts.has(commandId)),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    Effect.provideService(BoardThreadRows.BoardThreadRows, {
      list: () => Effect.succeed([{ threadId: THREAD }]),
    } as unknown as BoardThreadRows.BoardThreadRows["Service"]),
    Effect.provideService(ProjectionStore.ProjectionStoreV2, {
      getThreadRecords: (
        threadId: string,
        _fields: ReadonlyArray<string>,
        filter?: { readonly messageRunIds?: ReadonlyArray<string> },
      ) =>
        Effect.sync(() => {
          const thread = store.threads.get(threadId);
          return {
            thread: {
              lineage: { engineIntake: thread?.marker },
              archivedAt: null,
              modelSelection: thread?.modelSelection,
              worktreePath: thread?.worktreePath ?? null,
              runtimeMode: thread?.runtimeMode ?? "full-access",
            },
            runs: store.runs.filter((run) => run.threadId === threadId),
            subagents: store.subagents.filter((task) => task.threadId === threadId),
            providerTurns: store.providerTurns.filter((turn) => turn.threadId === threadId),
            messages: store.messages.filter(
              (message) =>
                message.threadId === threadId &&
                (filter?.messageRunIds === undefined ||
                  (message.runId !== null && filter.messageRunIds.includes(message.runId))),
            ),
          };
        }),
      getMessagesById: (threadId: string, ids: ReadonlyArray<string>) =>
        Effect.sync(
          () =>
            new Map(
              store.messages
                .filter((message) => message.threadId === threadId && ids.includes(message.id))
                .map((message) => [message.id, message]),
            ),
        ),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
    Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      listInstances: Effect.succeed(INSTANCES),
    } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]),
    Effect.provideService(Orchestrator.OrchestratorV2, {
      streamDomainEvents: Stream.empty,
    } as unknown as Orchestrator.OrchestratorV2["Service"]),
    Effect.provideService(IdAllocator.IdAllocatorV2, {
      derive: {
        delegatedTaskThread: ({ commandId }: { readonly commandId: string }) =>
          ThreadId.make(`child:${commandId}`),
      },
    } as unknown as IdAllocator.IdAllocatorV2["Service"]),
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

/** A t3-execution run's task, linked to its thread here. */
function board() {
  const engine = scratchEngine();
  engine.setBoard("work", "/work/repo");
  engine.addTask({ id: "task-7", title: "Ship the export" });
  engine.writeLink("task-7", { environmentId: ENVIRONMENT, threadId: THREAD, setBy: ENVIRONMENT });
  return engine;
}

const native = (engine: ScratchEngine) =>
  engine.events.filter((event) => event.kind.startsWith("native."));
const order = (engine: ScratchEngine, attempt: string) =>
  native(engine)
    .filter((event) => (event.data as { attempt: string }).attempt === attempt)
    .map((event) => event.kind);
const seatsOf = (command: OrchestrationV2ServerCommand | undefined) => {
  const source = command?.type === "message.dispatch" ? command.notification?.source : undefined;
  return source?.kind === "engine_stage" ? source.seats : [];
};
const resultOf = (engine: ScratchEngine, id: string) => engine.attempts.get(id)!.result;

it.effect("sends the brief in the engine's worktree, then reports the plan and the views", () => {
  const engine = board();
  engine.queueAttempt({
    id: "att-plan",
    task: "task-7",
    stage: "plan",
    kind: "team-plan",
    seat: "developer",
    lead: true,
    access: "read-only",
    participants: [
      { seat: "reviewer", role: "reviewer", harness: "codex", model: "gpt-6-astra" },
      { seat: "qa", role: "qa", harness: "codex", model: "gpt-6-astra" },
    ],
  });
  const store = threadStore();
  const claims = boardClaims(engine);
  return Effect.gen(function* () {
    const execution = yield* service(store, claims);
    // A person's turn runs: moving the thread's folder would end it, so the brief waits.
    const person = store.personTurn("How is it going?");
    yield* execution.reconcile();
    assert.deepEqual(order(engine, "att-plan"), ["native.claimed"]);
    assert.lengthOf(store.sent(), 0);
    person.status = "completed";
    yield* execution.reconcile();
    assert.deepEqual(store.kinds("thread.metadata.update", "thread.runtime-mode.set"), [
      "thread.metadata.update",
      "thread.runtime-mode.set",
    ]);
    assert.equal(store.threads.get(THREAD)!.worktreePath, "/work/run-1");
    assert.equal(store.threads.get(THREAD)!.runtimeMode, "approval-required");
    const [brief] = store.sent();
    if (brief === undefined) throw new Error("Expected the brief");
    assert.equal(brief.messageId, briefMessageId("att-plan"));
    // No notification: the native path runs the team round before the lead's turn.
    assert.isUndefined(brief.notification);
    assert.equal(brief.createdBy, "system");
    assert.isTrue(brief.text.startsWith("# Ship the export\n\nComplete the task."));
    assert.isTrue(brief.text.endsWith("## How to answer\n\nDo the team-plan step."));
    const run = store.runOf(briefMessageId("att-plan"));
    assert.deepEqual(engine.attempts.get("att-plan")!.native, {
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      runId: run.id,
    });
    // The lead's seat is attested with what its provider says it runs.
    store.ranOn(THREAD, run, "claude-fable-5-1-0815");
    yield* execution.reconcile();
    assert.deepEqual(
      engine.attestations.map(({ seat, threadId, model, harness }) => [
        seat,
        threadId,
        model,
        harness,
      ]),
      [["developer", THREAD, "claude-fable-5-1-0815", "claude"]],
    );
    // The team round: one view with a reported model, one whose provider reported none.
    const view = (seat: string, ran?: { model?: string; answer?: string }) =>
      store.child(
        {
          id: `node:${seat}`,
          threadId: THREAD,
          runId: run.id,
          childThreadId: ThreadId.make(`child:${seat}`),
          title: `${seat} · contribution`,
          driver: "codex",
          model: "gpt-6-astra",
          teamChat: { sourceRunId: run.id, stage: "contribution", seat },
        },
        "completed",
        ran,
      );
    view("reviewer", { model: "gpt-6-astra-0601" });
    view("qa", {});
    store.subagents.find((task) => task.id === "node:reviewer")!.result = "Looks right.";
    store.subagents.find((task) => task.id === "node:qa")!.result = "No harness.";
    store.subagents.find((task) => task.id === "node:qa")!.status = "failed";
    store.child({
      id: "node:critique",
      threadId: THREAD,
      runId: run.id,
      childThreadId: ThreadId.make("child:critique"),
      title: "reviewer · critique",
      driver: "codex",
      model: "gpt-6-astra",
      teamChat: { sourceRunId: run.id, stage: "critique", seat: "reviewer" },
    });
    store.reply(briefMessageId("att-plan"), '```json\n{"approach":"Ship it"}\n```');
    yield* execution.reconcile();
    // A critique still running holds the plan.
    assert.equal(engine.attempts.get("att-plan")!.state, "claimed");
    store.subagents.find((task) => task.id === "node:critique")!.status = "completed";
    yield* execution.reconcile();
    assert.deepEqual(order(engine, "att-plan"), [
      "native.claimed",
      "native.attached",
      "native.completed",
    ]);
    assert.deepEqual(resultOf(engine, "att-plan"), {
      text: '```json\n{"approach":"Ship it"}\n```',
      reason: null,
      model: "claude-fable-5-1-0815",
      harness: "claude",
      contributions: [
        {
          seat: "reviewer",
          childThreadId: "child:reviewer",
          model: "gpt-6-astra-0601",
          harness: "codex",
          state: "completed",
          text: "Looks right.",
        },
        // No model reported is no identity told, not even the harness: the engine fails closed.
        {
          seat: "qa",
          childThreadId: "child:qa",
          state: "failed",
          text: "No harness.",
        },
      ],
    });
    // The thread is given back the folder and mode it was made with.
    assert.isNull(store.threads.get(THREAD)!.worktreePath);
    assert.equal(store.threads.get(THREAD)!.runtimeMode, "full-access");
  }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-brief-")));
});

it.effect.each(["a run that holds it ends", "this server restarts"] as const)(
  "gives the thread back its folder and mode once %s, after the plan was told",
  (after) => {
    const engine = board();
    engine.queueAttempt({
      id: "att-plan",
      task: "task-7",
      stage: "plan",
      kind: "team-plan",
      seat: "developer",
      lead: true,
      access: "read-only",
    });
    const store = threadStore();
    const claims = boardClaims(engine);
    return Effect.gen(function* () {
      const execution = yield* service(store, claims);
      yield* execution.reconcile();
      const plan = store.runOf(briefMessageId("att-plan"));
      store.ranOn(THREAD, plan, "claude-fable-5-1");
      store.reply(briefMessageId("att-plan"), '{"approach":"Ship it"}');
      // A person's turn starts as the plan ends: the thread cannot move while it runs.
      const person = store.personTurn("And the tests?");
      yield* execution.reconcile();
      assert.equal(engine.attempts.get("att-plan")!.state, "completed");
      assert.equal(store.threads.get(THREAD)!.worktreePath, "/work/run-1");
      assert.equal(store.threads.get(THREAD)!.runtimeMode, "approval-required");
      person.status = "completed";
      // The engine lists no finished attempt: what is owed is read from the thread alone.
      engine.attempts.clear();
      const next = after === "this server restarts" ? yield* service(store, claims) : execution;
      yield* next.reconcile();
      assert.isNull(store.threads.get(THREAD)!.worktreePath);
      assert.equal(store.threads.get(THREAD)!.runtimeMode, "full-access");
      // Given back once: a later pass owes nothing.
      const sent = store.commands.length;
      yield* next.reconcile();
      assert.lengthOf(store.commands, sent);
    }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-give-back-")));
  },
);

it.effect.each([
  { model: "claude-sonnet-5-5", runsOn: "claude-sonnet-5-5" },
  { model: null, runsOn: "claude-fable-5-1" },
])("runs a lead step ($model) as a subagent in the engine's worktree", ({ model, runsOn }) => {
  const engine = board();
  engine.queueAttempt({
    id: "att-review",
    task: "task-7",
    stage: "review",
    kind: "review",
    seat: "developer",
    lead: true,
    model,
    access: "read-only",
    worktree: "/work/review-1",
  });
  const store = threadStore();
  return Effect.gen(function* () {
    const execution = yield* service(store, boardClaims(engine));
    yield* execution.reconcile();
    const [step] = store.sent();
    if (step === undefined) throw new Error("Expected the lead's stage turn");
    // The orchestrator takes a notification only as a queued agent message.
    assert.equal(step.createdBy, "agent");
    assert.equal(step.dispatchMode.type, "queue_after_active");
    assert.deepEqual(seatsOf(step), [
      {
        attemptId: "att-review",
        seat: "developer",
        childThreadId: childOf("att-review"),
        modelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), runsOn),
        access: "read-only",
        worktreePath: "/work/review-1",
      },
    ]);
    // The task thread itself keeps its own folder: the step runs in its subagent's.
    assert.isNull(store.threads.get(THREAD)!.worktreePath);
    assert.deepEqual(engine.attempts.get("att-review")!.native, {
      environmentId: ENVIRONMENT,
      threadId: childOf("att-review"),
      runId: null,
    });
    store.startSeats(step.messageId);
    store.finishSeat("att-review", '{"verdict":"approve"}', "completed", `${runsOn}-0815`);
    yield* execution.reconcile();
    assert.deepInclude(resultOf(engine, "att-review")!, {
      text: '{"verdict":"approve"}',
      model: `${runsOn}-0815`,
      harness: "claude",
    });
  }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-lead-")));
});

it.effect("starts a stage's seats under one system turn and reports what really ran", () => {
  const engine = board();
  for (const [id, seat, model, harness] of [
    ["att-qa-1", "qa-claude", "claude-fable-5-1", "claude"],
    ["att-qa-2", "qa-codex", "gpt-6-astra", "codex"],
  ] as const)
    engine.queueAttempt({
      id,
      task: "task-7",
      stage: "qa",
      kind: "qa",
      seat,
      access: "read-only",
      worktree: `/work/${id}`,
      model,
      harness,
    });
  // Workspace access writes, as full access does.
  engine.queueAttempt({
    id: "att-specialist",
    task: "task-7",
    stage: "qa",
    kind: "specialist",
    seat: "specialist",
    access: "workspace",
    worktree: "/work/att-specialist",
  });
  const store = threadStore();
  return Effect.gen(function* () {
    const execution = yield* service(store, boardClaims(engine));
    yield* execution.reconcile();
    const sent = store.sent();
    assert.lengthOf(sent, 1);
    const [qa] = sent;
    assert.equal(qa?.text, "Engine: qa-claude, qa-codex, specialist start qa");
    assert.deepEqual(seatsOf(qa), [
      {
        attemptId: "att-qa-1",
        seat: "qa-claude",
        childThreadId: childOf("att-qa-1"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-fable-5-1",
        ),
        access: "read-only",
        worktreePath: "/work/att-qa-1",
      },
      {
        attemptId: "att-qa-2",
        seat: "qa-codex",
        childThreadId: childOf("att-qa-2"),
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra"),
        access: "read-only",
        worktreePath: "/work/att-qa-2",
      },
      {
        attemptId: "att-specialist",
        seat: "specialist",
        childThreadId: childOf("att-specialist"),
        modelSelection: LEAD,
        access: "full",
        worktreePath: "/work/att-specialist",
      },
    ] satisfies ReadonlyArray<OrchestrationV2EngineStageSeat>);
    assert.deepEqual(engine.attempts.get("att-qa-1")!.native, {
      environmentId: ENVIRONMENT,
      childThreadId: childOf("att-qa-1"),
    });
    // Attested before the children start, so a QA seat's receipts are its own.
    assert.deepEqual(
      engine.attestations.map((row) => [row.seat, row.threadId, row.model, row.harness]),
      [
        ["qa-claude", childOf("att-qa-1"), "claude-fable-5-1", "claude"],
        ["qa-codex", childOf("att-qa-2"), "gpt-6-astra", "codex"],
        ["specialist", childOf("att-specialist"), "claude-fable-5-1", "claude"],
      ],
    );
    for (const stage of store.stages()) store.startSeats(stage);
    store.finishSeat("att-qa-1", "All three items pass.", "completed", "claude-fable-5-1");
    yield* execution.reconcile();
    assert.equal(engine.attempts.get("att-qa-1")!.state, "completed");
    assert.equal(resultOf(engine, "att-qa-1")?.text, "All three items pass.");
    assert.equal(engine.attempts.get("att-qa-2")!.state, "claimed");
    // The provider ran this seat on another model than the engine picked: that is what is told.
    store.finishSeat("att-qa-2", "Item 2 fails.", "failed", "gpt-6-mini");
    // This one's provider reported no model: none is told, and the engine fails closed.
    store.finishSeat("att-specialist", "Done.");
    yield* execution.reconcile();
    assert.deepInclude(resultOf(engine, "att-qa-2")!, {
      text: "Item 2 fails.",
      model: "gpt-6-mini",
      harness: "codex",
    });
    assert.equal(engine.attempts.get("att-qa-2")!.state, "failed");
    assert.deepInclude(resultOf(engine, "att-specialist")!, {
      text: "Done.",
      model: null,
      harness: null,
    });
    assert.deepEqual(
      engine.attestations.filter((row) => row.seat === "qa-codex").map((row) => row.model),
      ["gpt-6-astra", "gpt-6-mini"],
    );
    // Each stage turn was sent once, whatever the passes.
    assert.lengthOf(store.sent(), 1);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-seats-")));
});

it.effect("replays a step after this server restarts mid-attempt", () => {
  const engine = board();
  engine.queueAttempt({
    id: "att-build",
    task: "task-7",
    stage: "build",
    kind: "build",
    seat: "developer-2",
  });
  engine.queueAttempt({
    id: "att-plan",
    task: "task-7",
    stage: "plan",
    kind: "team-plan",
    seat: "developer",
    lead: true,
  });
  const store = threadStore();
  const claims = boardClaims(engine);
  return Effect.gen(function* () {
    // The answers to both attaches are lost: each turn is sent, and no receipt reached the engine.
    engine.dropNext(/att-build\/attach$/);
    engine.dropNext(/att-plan\/attach$/);
    yield* (yield* service(store, claims)).reconcile();
    assert.isNull(engine.attempts.get("att-build")!.native);
    assert.equal(engine.attempts.get("att-build")!.owner, OWNER);
    assert.lengthOf(store.sent(), 2);
    // A new process: the same thread, receipts and engine records, and nothing in memory.
    const restarted = yield* service(store, claims);
    yield* restarted.reconcile();
    assert.lengthOf(store.sent(), 2);
    assert.equal(engine.attempts.get("att-build")!.native?.childThreadId, childOf("att-build"));
    assert.equal(
      engine.attempts.get("att-plan")!.native?.runId,
      store.runOf(briefMessageId("att-plan")).id,
    );
    store.startSeats(store.stages()[0]!);
    store.finishSeat("att-build", "Built.", "completed", "claude-fable-5-1");
    const plan = store.runOf(briefMessageId("att-plan"));
    store.ranOn(THREAD, plan, "claude-fable-5-1");
    store.reply(briefMessageId("att-plan"), '{"approach":"Ship it"}');
    yield* (yield* service(store, claims)).reconcile();
    for (const attempt of ["att-build", "att-plan"])
      assert.deepEqual(order(engine, attempt), [
        "native.claimed",
        "native.attached",
        "native.completed",
      ]);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-restart-")));
});

it.effect("stops held steps the engine cancels after its own restart", () => {
  const engine = board();
  engine.queueAttempt({
    id: "att-plan",
    task: "task-7",
    stage: "plan",
    kind: "team-plan",
    seat: "developer",
    lead: true,
  });
  engine.queueAttempt({
    id: "att-build",
    task: "task-7",
    stage: "build",
    kind: "build",
    seat: "developer-2",
  });
  engine.queueAttempt({
    id: "att-qa",
    task: "task-7",
    stage: "qa",
    kind: "qa",
    seat: "qa",
    access: "read-only",
  });
  const store = threadStore();
  return Effect.gen(function* () {
    const execution = yield* service(store, boardClaims(engine));
    yield* execution.reconcile();
    // The brief runs; the build and QA turns wait behind it.
    const build = store.stages().map(store.runOf);
    assert.deepEqual(
      build.map((run) => run.status),
      ["queued", "queued"],
    );
    store.startSeats(store.stages()[0]!);
    // recover() asks every claimed step to stop. The running brief is interrupted, the build's
    // child is stopped, and QA's queued stage turn is cancelled before it starts any child.
    for (const id of ["att-plan", "att-build", "att-qa"]) engine.cancelAttempt(id);
    yield* execution.reconcile();
    assert.deepEqual(store.kinds("run.interrupt", "subagent.stop", "queued-run.cancel"), [
      "run.interrupt",
      "subagent.stop",
      "queued-run.cancel",
    ]);
    yield* execution.reconcile();
    assert.equal(engine.attempts.get("att-plan")!.state, "interrupted");
    assert.equal(engine.attempts.get("att-build")!.state, "cancelled");
    assert.equal(engine.attempts.get("att-qa")!.state, "cancelled");
    assert.equal(resultOf(engine, "att-qa")?.reason, "Stopped before its subagent started.");
  }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-cancel-")));
});

it.effect("fails a seat whose stage turn ended before its subagent started", () => {
  const engine = board();
  engine.queueAttempt({
    id: "att-build",
    task: "task-7",
    stage: "build",
    kind: "build",
    seat: "developer-2",
  });
  const store = threadStore();
  return Effect.gen(function* () {
    const execution = yield* service(store, boardClaims(engine));
    yield* execution.reconcile();
    // The turn did not start: its seat dispatch was refused, as a rejected delegation fails it.
    store.runOf(store.stages()[0]!).status = "failed";
    yield* execution.reconcile();
    assert.equal(engine.attempts.get("att-build")!.state, "failed");
    assert.equal(
      resultOf(engine, "att-build")?.reason,
      "Its stage turn ended failed before this seat's subagent started.",
    );
  }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-stage-failed-")));
});

it.effect("advances no step without a live claim on its task, after a restart too", () => {
  const engine = board();
  engine.queueAttempt({
    id: "att-build",
    task: "task-7",
    stage: "build",
    kind: "build",
    seat: "developer-2",
  });
  const store = threadStore();
  const claims = boardClaims(engine);
  return Effect.gen(function* () {
    yield* (yield* service(store, claims)).reconcile();
    store.startSeats(store.stages()[0]!);
    store.finishSeat("att-build", "Built.", "completed", "claude-fable-5-1");
    // After a restart the claim is refused: another holder took the lapsed lease.
    engine.advance(200_000);
    engine.handle("POST", "/api/orchestration/tasks/task-7/claim", { origin: "thread:else/x" });
    yield* (yield* service(store, boardClaims(engine))).reconcile();
    assert.equal(engine.attempts.get("att-build")!.state, "claimed");
    assert.deepEqual(order(engine, "att-build"), ["native.claimed", "native.attached"]);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-unheld-")));
});

it.effect("keeps a stage turn's id when only some of its seats were attached", () => {
  const engine = board();
  for (const id of ["att-qa-1", "att-qa-2"])
    engine.queueAttempt({ id, task: "task-7", stage: "qa", kind: "qa", seat: id });
  const store = threadStore();
  const claims = boardClaims(engine);
  return Effect.gen(function* () {
    // The first seat's attach lands; the second's answer is lost.
    engine.dropNext(/att-qa-2\/attach$/);
    yield* (yield* service(store, claims)).reconcile();
    assert.isNotNull(engine.attempts.get("att-qa-1")!.native);
    assert.isNull(engine.attempts.get("att-qa-2")!.native);
    yield* (yield* service(store, claims)).reconcile();
    // The seat left is attached to the turn it was sent in, which is never sent again.
    assert.lengthOf(store.sent(), 1);
    assert.deepEqual(
      seatsOf(store.sent()[0]).map((seat) => seat.attemptId),
      ["att-qa-1", "att-qa-2"],
    );
    assert.equal(engine.attempts.get("att-qa-2")!.native?.childThreadId, childOf("att-qa-2"));
  }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-partial-attach-")));
});

it.effect("keeps the task's claim alive while it holds a step", () => {
  const engine = board();
  engine.queueAttempt({
    id: "att-build",
    task: "task-7",
    stage: "build",
    kind: "build",
    seat: "developer-2",
  });
  const store = threadStore();
  const claims = boardClaims(engine);
  return Effect.gen(function* () {
    const execution = yield* service(store, claims);
    yield* execution.reconcile();
    // Well past the 120 second lease: every pass renews it while the build runs.
    for (let pass = 0; pass < 4; pass += 1) {
      engine.advance(90_000);
      yield* execution.reconcile();
      assert.isNotNull(engine.leaseOf("task-7"));
    }
    assert.lengthOf(claims.calls, 5);
    assert.lengthOf(
      engine.events.filter((event) => event.kind === "orchestration.claimed"),
      1,
    );
    assert.lengthOf(store.sent(), 1);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-lease-")));
});

it.effect("leaves engine boards, foreign threads and unheld tasks to the engine", () => {
  const engine = board();
  // A split parent has no thread; its step is the engine's after the hand-off wait.
  engine.addTask({ id: "parent-1", state: "split" });
  engine.queueAttempt({
    id: "att-split",
    task: "parent-1",
    stage: "plan",
    kind: "team-plan",
    seat: "developer",
    lead: true,
  });
  // Another server's step.
  engine.queueAttempt({
    id: "att-theirs",
    task: "task-7",
    stage: "build",
    kind: "build",
    seat: "developer-2",
  });
  engine.attempts.get("att-theirs")!.owner = "t3-board:other";
  const store = threadStore();
  return Effect.gen(function* () {
    yield* (yield* service(store, boardClaims(engine))).reconcile();
    assert.lengthOf(native(engine), 0);
    assert.lengthOf(store.commands, 0);
    // An engine board's run queues no v2 record, and an engine before v2 lists version 1 only.
    engine.attempts.clear();
    yield* (yield* service(store, boardClaims(engine))).reconcile();
    assert.lengthOf(native(engine), 0);
    // With the task's claim refused (the cap is reached), no step is claimed.
    engine.queueAttempt({
      id: "att-build",
      task: "task-7",
      stage: "build",
      kind: "build",
      seat: "developer-2",
    });
    engine.handle("POST", "/api/orchestration/tasks/task-7/claim", { origin: "thread:else/x" });
    yield* (yield* service(store, boardClaims(engine))).reconcile();
    assert.lengthOf(native(engine), 0);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-untouched-")));
});
