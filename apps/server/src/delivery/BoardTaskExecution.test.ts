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
import { briefMessageId, leadTurnMessageId, seatCommandId } from "./boardTaskAttempts.ts";
import * as BoardTaskExecution from "./BoardTaskExecution.ts";
import * as BoardTaskThreads from "./BoardTaskThreads.ts";
import {
  scratchEngine,
  scratchEngineHttp,
  type ScratchEngine,
} from "./boardThreadEngine.testkit.ts";
import { boardTaskOf, boardTaskThreadId, boardTaskThreadMarker } from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";

// Every case runs against the scratch engine's model of native attempts v2, through the delivery
// service's real request path, over a thread store that keeps the committed messages, runs and
// subagents across a restart of this server.

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
  executedModel?: string;
  readonly teamChat?: {
    readonly sourceRunId: RunId;
    readonly stage: string;
    readonly seat: string;
  };
  status: string;
  result: string | null;
}

/** What the thread store keeps across a restart of this server: its commits and receipts. */
function threadStore() {
  const marker = boardTaskThreadMarker(TASK);
  const threads = new Map([[THREAD as string, { marker, modelSelection: LEAD }]]);
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
  const receipts = new Set<string>();
  const commands: Array<OrchestrationV2ServerCommand> = [];
  /** The events the commands committed, in order. */
  const events: Array<{ readonly type: string; readonly id: string }> = [];

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
        const modelSelection =
          command.modelSelection ?? threads.get(command.threadId)!.modelSelection;
        const run = {
          id: RunId.make(`run:${command.messageId}`),
          threadId: command.threadId,
          userMessageId: command.messageId,
          ordinal: runs.length + 1,
          modelSelection,
          providerInstanceId: modelSelection.instanceId,
          status: "running",
        };
        runs.push(run);
        events.push({ type: "message.updated", id: command.messageId });
        events.push({ type: "run.created", id: run.id });
      }
      if (command.type === "run.interrupt") {
        runs.find((run) => run.id === command.runId)!.status = "interrupted";
        events.push({ type: "run.updated", id: command.runId });
      }
      if (command.type === "subagent.stop") {
        subagents.find((task) => task.id === command.subagentId)!.status = "cancelled";
        events.push({ type: "subagent.updated", id: command.subagentId });
      }
      return { storedEvents: [] };
    });

  const runOf = (messageId: MessageId) => runs.find((run) => run.userMessageId === messageId)!;
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
  /** The children `NativeTeamChat.prepareTurn` starts for an engine stage's seats. */
  const startSeats = (messageId: MessageId) => {
    const run = runOf(messageId);
    const message = messages.find((candidate) => candidate.id === messageId)!;
    const source = message.notification?.source;
    if (source?.kind !== "engine_stage") throw new Error("Expected an engine stage");
    for (const seat of source.seats) {
      subagents.push({
        id: `node:${seat.attemptId}`,
        threadId: run.threadId,
        runId: run.id,
        childThreadId: seat.childThreadId,
        title: `${seat.seat} · ${source.stage}`,
        driver: seat.modelSelection.instanceId === "codex" ? "codex" : "claudeAgent",
        model: seat.modelSelection.model,
        status: "running",
        result: null,
      });
      events.push({ type: "subagent.updated", id: `node:${seat.attemptId}` });
    }
    return source.seats;
  };
  /** A child's end, with the model the provider says it really ran on. */
  const finishSeat = (
    attemptId: string,
    result: string,
    status = "completed",
    executedModel?: string,
  ) => {
    const task = subagents.find((candidate) => candidate.id === `node:${attemptId}`)!;
    task.status = status;
    task.result = result;
    if (executedModel !== undefined) task.executedModel = executedModel;
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
  return {
    threads,
    messages,
    runs,
    subagents,
    receipts,
    commands,
    events,
    dispatch,
    runOf,
    reply,
    startSeats,
    finishSeat,
    sent,
    stages,
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
      hasReceipt: (commandId: string) => Effect.succeed(store.receipts.has(commandId)),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    Effect.provideService(ProjectionStore.ProjectionStoreV2, {
      getThreadRecords: (
        threadId: string,
        _fields: ReadonlyArray<string>,
        filter?: { readonly messageRunIds?: ReadonlyArray<string> },
      ) => {
        const thread = store.threads.get(threadId);
        return Effect.sync(() => ({
          thread: {
            lineage: { engineIntake: thread?.marker },
            archivedAt: null,
            modelSelection: thread?.modelSelection,
          },
          runs: store.runs.filter((run) => run.threadId === threadId),
          subagents: store.subagents.filter((task) => task.threadId === threadId),
          messages: store.messages.filter(
            (message) =>
              message.threadId === threadId &&
              (filter?.messageRunIds === undefined ||
                (message.runId !== null && filter.messageRunIds.includes(message.runId))),
          ),
        }));
      },
      getMessagesById: (threadId: string, ids: ReadonlyArray<string>) =>
        Effect.succeed(
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

it.effect("sends the team plan as the brief, then reports the plan with the seats' views", () => {
  const engine = board();
  engine.queueAttempt({
    id: "att-plan",
    task: "task-7",
    stage: "plan",
    kind: "team-plan",
    seat: "developer",
    lead: true,
    participants: [
      { seat: "reviewer", role: "reviewer", harness: "codex", model: "gpt-6-astra" },
      { seat: "qa", role: "qa", harness: "codex", model: "gpt-6-astra" },
    ],
  });
  const store = threadStore();
  const claims = boardClaims(engine);
  return Effect.gen(function* () {
    const execution = yield* service(store, claims);
    yield* execution.reconcile();
    const [brief] = store.sent();
    assert.equal(brief?.type === "message.dispatch" && brief.messageId, briefMessageId("att-plan"));
    // No notification: the native path runs the team round before the lead's turn.
    assert.isTrue(brief?.type === "message.dispatch" && brief.notification === undefined);
    assert.isTrue(
      brief?.type === "message.dispatch" &&
        brief.createdBy === "system" &&
        brief.text.startsWith("# Ship the export\n\nComplete the task.") &&
        brief.text.endsWith("## How to answer\n\nDo the team-plan step."),
    );
    const run = store.runOf(briefMessageId("att-plan"));
    assert.deepEqual(engine.attempts.get("att-plan")!.native, {
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      runId: run.id,
    });
    assert.deepEqual(
      engine.attestations.map(({ run, seat, threadId, model, harness }) => ({
        run,
        seat,
        threadId,
        model,
        harness,
      })),
      [
        {
          run: "run-1",
          seat: "developer",
          threadId: THREAD,
          model: "claude-fable-5-1",
          harness: "claude",
        },
      ],
    );
    // The team round's seats, and the lead's answer once every seat is terminal.
    for (const [seat, status, result] of [
      ["reviewer", "completed", "Looks right."],
      ["qa", "failed", "No harness."],
    ] as const)
      store.subagents.push({
        id: `node:${seat}`,
        threadId: THREAD,
        runId: run.id,
        childThreadId: ThreadId.make(`child:${seat}`),
        title: `${seat} · contribution`,
        driver: "codex",
        model: "gpt-6-astra",
        teamChat: { sourceRunId: run.id, stage: "contribution", seat },
        status,
        result,
      });
    store.subagents.push({
      ...store.subagents[0]!,
      id: "node:critique",
      teamChat: { sourceRunId: run.id, stage: "critique", seat: "reviewer" },
      status: "running",
    });
    store.reply(briefMessageId("att-plan"), '```json\n{"approach":"Ship it"}\n```');
    yield* execution.reconcile();
    // A critique still running holds the plan.
    assert.equal(engine.attempts.get("att-plan")!.state, "claimed");
    store.subagents.pop();
    yield* execution.reconcile();
    assert.deepEqual(order(engine, "att-plan"), [
      "native.claimed",
      "native.attached",
      "native.completed",
    ]);
    assert.deepEqual(engine.attempts.get("att-plan")!.result, {
      text: '```json\n{"approach":"Ship it"}\n```',
      reason: null,
      model: "claude-fable-5-1",
      harness: "claude",
      contributions: [
        {
          seat: "reviewer",
          childThreadId: "child:reviewer",
          model: "gpt-6-astra",
          harness: "codex",
          state: "completed",
          text: "Looks right.",
        },
        {
          seat: "qa",
          childThreadId: "child:qa",
          model: "gpt-6-astra",
          harness: "codex",
          state: "failed",
          text: "No harness.",
        },
      ],
    });
    assert.deepEqual(
      store.events.map((event) => event.type),
      ["message.updated", "run.created", "run.updated"],
    );
  }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-brief-")));
});

it.effect.each([
  { model: "claude-sonnet-5-5", turn: "claude-sonnet-5-5" },
  { model: null, turn: "claude-fable-5-1" },
])("runs a lead step on its account family ($model) as a system turn", ({ model, turn }) => {
  const engine = board();
  engine.queueAttempt({
    id: "att-review",
    task: "task-7",
    stage: "review",
    kind: "review",
    seat: "developer",
    lead: true,
    model,
  });
  const store = threadStore();
  return Effect.gen(function* () {
    const execution = yield* service(store, boardClaims(engine));
    yield* execution.reconcile();
    const [step] = store.sent();
    if (step?.type !== "message.dispatch") throw new Error("Expected the lead's turn");
    assert.equal(step.messageId, leadTurnMessageId("att-review"));
    // A system notice: `prepareTurn` starts no team round for it.
    assert.equal(step.notification?.source.kind, "system");
    assert.equal(store.runOf(step.messageId).modelSelection.model, turn);
    store.reply(step.messageId, '{"verdict":"approve"}');
    yield* execution.reconcile();
    assert.deepInclude(engine.attempts.get("att-review")!.result!, {
      text: '{"verdict":"approve"}',
      model: turn,
    });
  }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-lead-")));
});

it.effect("starts a stage's seats under one system turn and reports each child's answer", () => {
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
  // A lead step on another harness runs as a subagent of its own stage.
  engine.queueAttempt({
    id: "att-checks",
    task: "task-7",
    stage: "checks",
    kind: "checks",
    seat: "lead",
    lead: true,
    harness: "codex",
    model: "gpt-6-astra",
  });
  const store = threadStore();
  return Effect.gen(function* () {
    const execution = yield* service(store, boardClaims(engine));
    yield* execution.reconcile();
    const sent = store.sent();
    assert.lengthOf(sent, 2);
    const qa = sent.find((command) => seatsOf(command)[0]?.seat.startsWith("qa"));
    assert.isTrue(
      qa?.type === "message.dispatch" && qa.text === "Engine: qa-claude, qa-codex start qa",
    );
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
    ] satisfies ReadonlyArray<OrchestrationV2EngineStageSeat>);
    assert.deepEqual(engine.attempts.get("att-qa-1")!.native, {
      environmentId: ENVIRONMENT,
      childThreadId: childOf("att-qa-1"),
    });
    assert.deepEqual(engine.attempts.get("att-checks")!.native, {
      environmentId: ENVIRONMENT,
      threadId: childOf("att-checks"),
      runId: null,
    });
    // Attested before the children start, so a QA receipt is the seat's own.
    assert.deepEqual(
      engine.attestations.map((row) => [row.seat, row.threadId, row.model, row.harness]),
      [
        ["qa-claude", childOf("att-qa-1"), "claude-fable-5-1", "claude"],
        ["qa-codex", childOf("att-qa-2"), "gpt-6-astra", "codex"],
        ["lead", childOf("att-checks"), "gpt-6-astra", "codex"],
      ],
    );
    for (const stage of store.stages()) store.startSeats(stage);
    store.finishSeat("att-qa-1", "All three items pass.");
    yield* execution.reconcile();
    assert.equal(engine.attempts.get("att-qa-1")!.state, "completed");
    assert.equal(engine.attempts.get("att-qa-1")!.result?.text, "All three items pass.");
    assert.equal(engine.attempts.get("att-qa-2")!.state, "claimed");
    // The provider ran this seat on another model than the engine picked: that is what is told.
    store.finishSeat("att-qa-2", "Item 2 fails.", "failed", "gpt-6-mini");
    store.finishSeat("att-checks", '{"checks":[]}');
    yield* execution.reconcile();
    assert.deepInclude(engine.attempts.get("att-qa-2")!.result!, {
      text: "Item 2 fails.",
      model: "gpt-6-mini",
      harness: "codex",
    });
    assert.deepEqual(
      engine.attestations.filter((row) => row.seat === "qa-codex").map((row) => row.model),
      ["gpt-6-astra", "gpt-6-mini"],
    );
    assert.equal(engine.attempts.get("att-qa-2")!.state, "failed");
    assert.equal(engine.attempts.get("att-checks")!.result?.text, '{"checks":[]}');
    // Each seat's turn was sent once, whatever the passes.
    assert.lengthOf(store.sent(), 2);
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
    id: "att-review",
    task: "task-7",
    stage: "review",
    kind: "review",
    seat: "developer",
    lead: true,
  });
  const store = threadStore();
  const claims = boardClaims(engine);
  return Effect.gen(function* () {
    // The answers to both attaches are lost: each turn is sent, and no receipt reached the engine.
    engine.dropNext(/att-build\/attach$/);
    engine.dropNext(/att-review\/attach$/);
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
      engine.attempts.get("att-review")!.native?.runId,
      store.runOf(leadTurnMessageId("att-review")).id,
    );
    store.startSeats(store.stages()[0]!);
    store.finishSeat("att-build", "Built.");
    store.reply(leadTurnMessageId("att-review"), '{"verdict":"approve"}');
    yield* (yield* service(store, claims)).reconcile();
    assert.deepEqual(order(engine, "att-build"), [
      "native.claimed",
      "native.attached",
      "native.completed",
    ]);
    assert.deepEqual(order(engine, "att-review"), [
      "native.claimed",
      "native.attached",
      "native.completed",
    ]);
  }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-restart-")));
});

it.effect("stops a held step the engine cancels after its own restart", () => {
  const engine = board();
  engine.queueAttempt({
    id: "att-review",
    task: "task-7",
    stage: "review",
    kind: "review",
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
  const claims = boardClaims(engine);
  return Effect.gen(function* () {
    const execution = yield* service(store, claims);
    // The qa seat is not claimed yet when the engine restarts: recover() ends it there.
    engine.cancelAttempt("att-qa");
    yield* execution.reconcile();
    assert.notInclude(order(engine, "att-qa"), "native.claimed");
    store.startSeats(store.stages()[0]!);
    // recover() asks every claimed step to stop; T3 stops the turn and the child, and reports.
    engine.cancelAttempt("att-review");
    engine.cancelAttempt("att-build");
    yield* execution.reconcile();
    assert.deepEqual(
      store.commands.flatMap((command) =>
        command.type === "run.interrupt" || command.type === "subagent.stop" ? [command.type] : [],
      ),
      ["run.interrupt", "subagent.stop"],
    );
    yield* execution.reconcile();
    assert.equal(engine.attempts.get("att-review")!.state, "interrupted");
    assert.equal(engine.attempts.get("att-build")!.state, "cancelled");
  }).pipe(Effect.provide(deliveryLayer(engine, "board-execution-cancel-")));
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
