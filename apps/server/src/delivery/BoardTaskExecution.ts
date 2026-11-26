// The engine's model steps of a board task, run inside the task's T3 thread. The engine stays the
// referee: it schedules, caps and gates, and queues each step as a native attempt v2. T3 runs each
// one as a turn or a subagent of the thread and reports its answer. Nothing here decides a step or
// switches a board's execution.
import {
  DELIVERY_HARNESS_BY_DRIVER,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationV2EngineStageSeat,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { engineNotice } from "./BoardConversation.ts";
import {
  briefMessageId,
  engineStageNotice,
  isTerminalAttempt,
  leadTurnMessageId,
  NATIVE_ATTEMPTS_PATH,
  NativeAttempt,
  NativeAttemptList,
  nativeAttemptPath,
  seatCommandId,
  stageMessageId,
  stopCommandId,
  turnCommandId,
} from "./boardTaskAttempts.ts";
import * as BoardTaskThreads from "./BoardTaskThreads.ts";
import { boardTaskOfMarker, isBoardTaskThreadId } from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";
import { attestSeatWith } from "./SeatHandoffs.ts";
import { resolveSeatProvider, turnSelection } from "./seatProvider.ts";

const TaskDetail = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  acceptance: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  boardThread: Schema.optional(
    Schema.NullOr(Schema.Struct({ environmentId: Schema.String, threadId: Schema.String })),
  ),
});
type TaskDetail = typeof TaskDetail.Type;

const decodeList = Schema.decodeUnknownOption(NativeAttemptList);
const decodeAttempt = Schema.decodeUnknownEffect(NativeAttempt);
const decodeTaskDetail = Schema.decodeUnknownEffect(TaskDetail);

const TASK_ID = /^[\w-]{1,256}$/;
/** The engine's bound on a result's text; a longer answer is cut, never refused. */
const TEXT_LIMIT = 900_000;

const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
const terminalRun = (run: OrchestrationV2Run) => TERMINAL_RUN.has(run.status);
const terminalTask = (task: OrchestrationV2Subagent) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(task.status);
/** A terminal run or subagent as the engine's terminal states name it. */
const attemptState = (status: string) =>
  status === "completed" || status === "failed" || status === "interrupted" ? status : "cancelled";
/** The engine's name for a driver; a driver it has no name for is told by its own. */
const harnessOf = (driver: ProviderDriverKind | string | undefined) =>
  driver === undefined ? null : (DELIVERY_HARNESS_BY_DRIVER[driver] ?? driver);

/** How a step runs here: a turn of the task thread, a subagent of it, or not on this server. */
type Plan =
  | { readonly mode: "turn"; readonly modelSelection: ModelSelection | undefined }
  | { readonly mode: "seat"; readonly modelSelection: ModelSelection }
  | { readonly mode: "unavailable"; readonly why: string };

/**
 * The brief: the task as filed, then the engine's prompt, which says how to answer. It carries no
 * notification, so `NativeTeamChat.prepareTurn` runs the team round before the lead answers.
 */
const briefText = (detail: TaskDetail, prompt: string) =>
  [
    `# ${detail.title?.trim() || "Board task"}`,
    detail.body?.trim() ?? "",
    (detail.acceptance ?? []).length === 0
      ? ""
      : `Acceptance:\n${(detail.acceptance ?? []).map((item) => `- ${item}`).join("\n")}`,
    `## How to answer\n\n${prompt}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");

export class BoardTaskExecutionError extends Schema.TaggedError<BoardTaskExecutionError>()(
  "BoardTaskExecutionError",
  {
    reason: Schema.Literals(["engine", "thread"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class BoardTaskExecution extends Context.Service<
  BoardTaskExecution,
  {
    /** One pass over the engine's v2 attempts. Safe to repeat, and after any restart. */
    readonly reconcile: () => Effect.Effect<void, BoardTaskExecutionError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/delivery/BoardTaskExecution") {}

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const delivery = yield* DeliveryService.DeliveryService;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const boardThreads = yield* BoardTaskThreads.BoardTaskThreads;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const hostEnvironment = yield* HostProcess.Environment;
  const lock = yield* Semaphore.make(1);
  // The identity each step was attested with, kept in memory: after a restart each attached step
  // is attested once more.
  const attested = new Map<string, string>();
  const toldUnavailable = new Map<string, string>();

  const engine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) => new BoardTaskExecutionError({ reason: "engine", cause })),
    );
  const local = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) => new BoardTaskExecutionError({ reason: "thread", cause })),
    );

  const readAttempt = (id: string) =>
    engine(delivery.read({ path: nativeAttemptPath(id) })).pipe(
      Effect.flatMap((response) => engine(decodeAttempt(response.body))),
    );
  const act = (record: NativeAttempt, action: "claim" | "attach" | "complete", body: object) =>
    engine(
      delivery.nativeBuildAct({ path: `${nativeAttemptPath(record.id)}/${action}`, body }),
    ).pipe(Effect.flatMap((response) => engine(decodeAttempt(response.body))));

  /** The task's thread on this server, or null: the engine runs a step it has after its wait. */
  const taskThreadOf = Effect.fn("BoardTaskExecution.taskThreadOf")(function* (
    taskId: string,
    environmentId: EnvironmentId,
  ) {
    const detail = yield* engine(delivery.read({ path: `/api/tasks/${taskId}` })).pipe(
      Effect.flatMap((response) => engine(decodeTaskDetail(response.body))),
    );
    const link = detail.boardThread;
    // A split parent has no thread, and a task worked elsewhere has another environment's.
    if (!link || link.environmentId !== environmentId) return null;
    const threadId = ThreadId.make(link.threadId);
    const records = yield* projections
      .getThreadRecords(threadId, ["runs", "subagents"])
      .pipe(Effect.option);
    if (Option.isNone(records)) return null;
    const marked = boardTaskOfMarker(records.value.thread.lineage.engineIntake);
    if (marked?.id !== taskId || records.value.thread.archivedAt !== null) return null;
    return { threadId, detail, records: records.value };
  });

  const planOf = Effect.fn("BoardTaskExecution.planOf")(function* (
    record: NativeAttempt,
    current: ModelSelection,
    lineup: ReadonlyArray<{ readonly seat: string; readonly modelSelection: ModelSelection }>,
  ) {
    const providers = yield* instances.listInstances;
    if (record.lead) {
      if (record.model !== null) {
        // Another model of the thread's account family: the turn switches model in place.
        const switched = turnSelection(providers, current, {
          harness: record.harness,
          model: record.model,
        });
        if (switched !== undefined) return { mode: "turn", modelSelection: switched } as Plan;
      } else {
        const here = providers.find((provider) => provider.instanceId === current.instanceId);
        if (harnessOf(here?.driverKind) === record.harness)
          return { mode: "turn", modelSelection: undefined } as Plan;
      }
      // The brief is the thread's own turn: on another harness it keeps the thread's model,
      // and reports the model it ran.
      if (record.kind === "team-plan") return { mode: "turn", modelSelection: undefined } as Plan;
    }
    const provider = resolveSeatProvider(
      providers.filter((entry) => entry.enabled),
      record.harness,
      (entry) => entry.instanceId,
    );
    if (typeof provider === "string") return { mode: "unavailable", why: provider } as Plan;
    // A null model is the harness's own default: the seat's pick in the thread's team.
    const model =
      record.model ??
      lineup.find(
        (seat) =>
          seat.seat === record.seat && seat.modelSelection.instanceId === provider.instanceId,
      )?.modelSelection.model;
    if (!model) return { mode: "unavailable", why: "no-model" } as Plan;
    return {
      mode: "seat",
      modelSelection: createModelSelection(provider.instanceId, model),
    } as Plan;
  });

  const lastReply = Effect.fn("BoardTaskExecution.lastReply")(function* (
    threadId: ThreadId,
    runId: OrchestrationV2Run["id"],
  ) {
    const { messages } = yield* local(
      projections.getThreadRecords(threadId, ["messages"], { messageRunIds: [runId] }),
    );
    return (
      messages
        .filter(
          (message) =>
            message.role === "assistant" && message.runId === runId && !message.streaming,
        )
        .at(-1)?.text ?? ""
    );
  });

  /** The harness of the provider instance a run ran on. */
  const harnessOfInstance = Effect.fn("BoardTaskExecution.harnessOfInstance")(function* (
    instanceId: string | undefined,
  ) {
    if (instanceId === undefined) return null;
    const providers = yield* instances.listInstances;
    return harnessOf(providers.find((provider) => provider.instanceId === instanceId)?.driverKind);
  });

  /**
   * What a child did: its final answer, the last reply of its latest run or the result it
   * reported, and the model and harness that really ran it. The engine judges QA independence
   * by that identity, never by the model it picked.
   */
  const childOutcome = Effect.fn("BoardTaskExecution.childOutcome")(function* (
    task: OrchestrationV2Subagent,
  ) {
    const child =
      task.childThreadId === null
        ? Option.none()
        : yield* projections.getThreadRecords(task.childThreadId, ["runs"]).pipe(Effect.option);
    const latest = Option.isSome(child)
      ? child.value.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]
      : undefined;
    const text =
      latest === undefined || task.childThreadId === null
        ? ""
        : yield* lastReply(task.childThreadId, latest.id);
    const model =
      task.executedModel ??
      latest?.modelSelection.model ??
      task.modelSelection?.model ??
      task.model;
    const harness =
      (yield* harnessOfInstance(latest?.providerInstanceId)) ?? harnessOf(task.driver);
    // The engine fails closed on a step with no identity, so one is never left out or guessed.
    if (model === null || harness === null)
      return yield* new BoardTaskExecutionError({ reason: "thread" });
    return {
      text: (text.trim() ? text : (task.result ?? "")).slice(0, TEXT_LIMIT),
      model,
      harness,
    };
  });

  const reconcileTask = Effect.fn("BoardTaskExecution.reconcileTask")(function* (
    taskId: string,
    records: ReadonlyArray<NativeAttempt>,
    environmentId: EnvironmentId,
    owner: string,
  ) {
    const found = yield* taskThreadOf(taskId, environmentId);
    if (found === null) return;
    const { threadId, detail } = found;
    let shell = found.records;
    const refresh = Effect.suspend(() =>
      local(projections.getThreadRecords(threadId, ["runs", "subagents"])),
    ).pipe(Effect.tap((records) => Effect.sync(() => (shell = records))));
    // The claim on the task is its heartbeat: renewed on every pass while a step is held, so
    // the engine never sends a step T3 works to needs-decision after the board's hand-off wait.
    const held = yield* boardThreads.holdTask(taskId, threadId);
    const lineup =
      (yield* delivery.threadState(threadId).pipe(Effect.option)).pipe(
        Option.flatMap((state) => Option.fromNullishOr(state.lineup)),
        Option.map((value) => value.participants),
        Option.getOrUndefined,
      ) ?? [];

    const claim = Effect.fn("BoardTaskExecution.claim")(function* (record: NativeAttempt) {
      if (record.owner !== null) return record;
      // Without a live claim on the task the step stays the engine's, as does one it stopped.
      if (!held || record.cancelRequested) return null;
      const claimed = yield* act(record, "claim", { owner, worktree: record.worktree });
      return claimed.owner === owner ? claimed : null;
    });

    const attest = Effect.fn("BoardTaskExecution.attest")(function* (
      record: NativeAttempt,
      seatThreadId: ThreadId,
      model: string | null,
      harness: string | null,
    ) {
      const identity = `${model}/${harness}`;
      if (attested.get(record.id) === identity || model === null) return;
      const result = yield* attestSeatWith(delivery, hostEnvironment, {
        environmentId,
        run: record.run,
        seat: record.seat,
        threadId: seatThreadId,
        model,
        ...(harness === null ? {} : { harness }),
      }).pipe(Effect.result);
      if (result._tag === "Success") attested.set(record.id, identity);
      else
        yield* Effect.logWarning("A board seat was not attested; the next pass tries again.", {
          attempt: record.id,
          cause: result.failure.message,
        });
    });

    const complete = (
      record: NativeAttempt,
      receipt: { readonly threadId: ThreadId } | { readonly childThreadId: ThreadId },
      result: {
        readonly state: string;
        readonly text: string;
        readonly reason?: string | null;
        readonly model: string;
        readonly harness: string;
        readonly contributions?: ReadonlyArray<unknown>;
      },
    ) =>
      act(record, "complete", {
        owner,
        ...receipt,
        state: result.state,
        text: result.text.slice(0, TEXT_LIMIT),
        reason: result.reason ?? (result.state === "completed" ? null : `Ended ${result.state}.`),
        model: result.model,
        harness: result.harness,
        ...(result.contributions === undefined ? {} : { contributions: result.contributions }),
      }).pipe(Effect.tap(() => Effect.sync(() => attested.delete(record.id))));

    /**
     * What a step that never started is told as: the task thread's own model and harness, which
     * it was attached to. Nothing ran, so no verdict or contribution counts on it.
     */
    const unstarted = Effect.fn("BoardTaskExecution.unstarted")(function* () {
      const harness = yield* harnessOfInstance(shell.thread.modelSelection.instanceId);
      if (harness === null) return yield* new BoardTaskExecutionError({ reason: "thread" });
      return { model: shell.thread.modelSelection.model, harness };
    });

    /** The team plan, or a lead step on the thread's account family: a turn of the thread. */
    const stepTurn = Effect.fn("BoardTaskExecution.stepTurn")(function* (
      record: NativeAttempt,
      plan: Extract<Plan, { mode: "turn" }>,
    ) {
      const brief = record.kind === "team-plan";
      const messageId = brief ? briefMessageId(record.id) : leadTurnMessageId(record.id);
      let current = yield* claim(record);
      if (current === null || isTerminalAttempt(current.state)) return;
      const sent = (yield* local(projections.getMessagesById(threadId, [messageId]))).has(
        messageId,
      );
      if (!sent) {
        // Asked to stop before its turn was sent: nothing ran.
        if (current.cancelRequested || current.native !== null) {
          if (current.native === null)
            current = yield* act(current, "attach", { owner, environmentId, threadId });
          yield* complete(
            current,
            { threadId },
            { state: "cancelled", text: "", ...(yield* unstarted()) },
          );
          return;
        }
        const prompt = current.prompt?.trim();
        if (!prompt) return yield* new BoardTaskExecutionError({ reason: "engine" });
        yield* local(
          threads.dispatch({
            type: "message.dispatch",
            commandId: turnCommandId(messageId),
            threadId,
            messageId,
            text: brief ? briefText(detail, prompt) : prompt,
            attachments: [],
            ...(plan.modelSelection === undefined ? {} : { modelSelection: plan.modelSelection }),
            // The brief runs the team round. Every other engine turn is a system notice, which
            // starts none.
            ...(brief
              ? {}
              : {
                  notification: engineNotice(
                    `Engine: ${current.seat} ${current.kind}`,
                    `The engine's ${current.kind} step of the ${current.stage} stage. Answer as its contract says.`,
                  ),
                }),
            // Never over a person's turn: queued behind it.
            dispatchMode: { type: "queue_after_active" },
            createdBy: "system",
            creationSource: "server",
          }),
        );
        yield* refresh;
      }
      const run = shell.runs.find((candidate) => candidate.userMessageId === messageId);
      if (run === undefined) return;
      if (current.native === null)
        current = yield* act(current, "attach", { owner, environmentId, threadId, runId: run.id });
      // What the turn ran on: its run's provider instance and the model it started.
      const harness = yield* harnessOfInstance(run.providerInstanceId);
      if (harness === null) return yield* new BoardTaskExecutionError({ reason: "thread" });
      yield* attest(current, threadId, run.modelSelection.model, harness);
      if (!terminalRun(run)) {
        if (current.cancelRequested)
          yield* local(
            threads.dispatch({
              type: "run.interrupt",
              commandId: stopCommandId(current.id),
              threadId,
              runId: run.id,
              reason: "The delivery engine asked to stop this step.",
            }),
          );
        return;
      }
      const children = shell.subagents.filter(
        (task) => task.runId === run.id || task.teamChat?.sourceRunId === run.id,
      );
      if (children.some((task) => !terminalTask(task))) return;
      const participants = current.participants ?? [];
      const contributions = brief
        ? children.flatMap((task) => {
            const seat = task.teamChat?.seat;
            const joined = participants.some((entry) => entry.seat === seat);
            // What the seat's child really ran on, as for any seat.
            const model = task.executedModel ?? task.modelSelection?.model ?? task.model;
            const harness = harnessOf(task.driver);
            return task.teamChat?.stage !== "contribution" ||
              seat === undefined ||
              !joined ||
              task.childThreadId === null ||
              model === null ||
              harness === null
              ? []
              : [
                  {
                    seat,
                    childThreadId: task.childThreadId,
                    model,
                    harness,
                    state: attemptState(task.status),
                    text: (task.result ?? "").slice(0, 25_000),
                  },
                ];
          })
        : undefined;
      yield* complete(
        current,
        { threadId },
        {
          state: attemptState(run.status),
          text: yield* lastReply(threadId, run.id),
          model: run.modelSelection.model,
          harness,
          ...(contributions === undefined ? {} : { contributions: contributions.slice(0, 32) }),
        },
      );
    });

    /** Seats, and a lead on another harness: subagents of one system turn per batch. */
    const stepSeats = Effect.fn("BoardTaskExecution.stepSeats")(function* (
      entries: ReadonlyArray<{ readonly record: NativeAttempt; readonly plan: Plan }>,
    ) {
      const childOf = (record: NativeAttempt) =>
        ids.derive.delegatedTaskThread({ commandId: seatCommandId(threadId, record.id) });
      const receiptOf = (record: NativeAttempt) =>
        record.lead ? { threadId: childOf(record) } : { childThreadId: childOf(record) };
      const owned: Array<{ record: NativeAttempt; plan: Plan }> = [];
      for (const entry of entries) {
        if (entry.plan.mode === "unavailable" && entry.record.owner === null) {
          if (toldUnavailable.get(entry.record.id) !== entry.plan.why) {
            toldUnavailable.set(entry.record.id, entry.plan.why);
            yield* Effect.logInfo("A board step has no provider here; the engine keeps it.", {
              attempt: entry.record.id,
              harness: entry.record.harness,
              why: entry.plan.why,
            });
          }
          continue;
        }
        const current = yield* claim(entry.record);
        if (current !== null && !isTerminalAttempt(current.state))
          owned.push({ record: current, plan: entry.plan });
      }
      const unsent = owned.filter(({ record }) => record.native === null);
      const batches = new Map<
        string,
        Array<{ record: NativeAttempt; plan: Extract<Plan, { mode: "seat" }> }>
      >();
      for (const { record, plan } of unsent) {
        // Claimed here before, and can no longer run here, or stopped before it started.
        if (plan.mode !== "seat" || record.cancelRequested) {
          const attached = yield* act(record, "attach", {
            owner,
            environmentId,
            ...receiptOf(record),
          });
          yield* complete(attached, receiptOf(record), {
            ...(yield* unstarted()),
            state: record.cancelRequested ? "cancelled" : "failed",
            text: "",
            reason: record.cancelRequested
              ? "Stopped before its subagent started."
              : `No provider runs this seat here (${plan.mode === "unavailable" ? plan.why : "turn"}).`,
          });
          continue;
        }
        const key = `${record.run}\u0000${record.stage}`;
        batches.set(key, [...(batches.get(key) ?? []), { record, plan }]);
      }
      for (const batch of batches.values()) {
        const sorted = batch.toSorted((a, b) => a.record.id.localeCompare(b.record.id));
        const seats: Array<OrchestrationV2EngineStageSeat> = sorted.map(({ record, plan }) => ({
          attemptId: record.id,
          seat: record.seat,
          childThreadId: childOf(record),
          modelSelection: plan.modelSelection,
          // Workspace access writes, as full access does.
          access: record.access === "read-only" ? "read-only" : "full",
          worktreePath: record.worktree,
        }));
        const stage = sorted[0]!.record.stage;
        const messageId = stageMessageId(sorted[0]!.record.id);
        const notification = engineStageNotice(stage, seats);
        yield* local(
          threads.dispatch({
            type: "message.dispatch",
            commandId: turnCommandId(messageId),
            threadId,
            messageId,
            text: notification.summary,
            notification,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "system",
            creationSource: "server",
          }),
        );
        const providers = yield* instances.listInstances;
        for (const { record, plan } of sorted) {
          const attached = yield* act(record, "attach", {
            owner,
            environmentId,
            ...receiptOf(record),
          });
          const index = owned.findIndex((entry) => entry.record.id === record.id);
          if (index >= 0) owned[index] = { record: attached, plan };
          // Attested before its subagent starts, so a QA seat's receipts are its own.
          const driver = providers.find(
            (provider) => provider.instanceId === plan.modelSelection.instanceId,
          )?.driverKind;
          yield* attest(attached, childOf(record), plan.modelSelection.model, harnessOf(driver));
        }
      }
      if (batches.size > 0) yield* refresh;
      for (const { record } of owned) {
        if (record.native === null || isTerminalAttempt(record.state)) continue;
        const child = childOf(record);
        const task = shell.subagents.find((candidate) => candidate.childThreadId === child);
        if (record.cancelRequested) {
          if (task !== undefined && !terminalTask(task) && task.runId !== null) {
            yield* local(
              threads.dispatch({
                type: "subagent.stop",
                commandId: stopCommandId(record.id),
                threadId,
                runId: task.runId,
                subagentId: task.id,
              }),
            );
            continue;
          }
          if (
            task === undefined &&
            !(yield* local(threads.hasReceipt(seatCommandId(threadId, record.id))))
          ) {
            yield* complete(record, receiptOf(record), {
              ...(yield* unstarted()),
              state: "cancelled",
              text: "",
              reason: "Stopped before its subagent started.",
            });
            continue;
          }
        }
        if (task === undefined || !terminalTask(task)) continue;
        const outcome = yield* childOutcome(task);
        // Attested again when the seat ran on something other than it was attested with.
        yield* attest(record, child, outcome.model, outcome.harness);
        yield* complete(record, receiptOf(record), {
          state: attemptState(task.status),
          ...outcome,
        });
      }
    });

    // One step that does not advance never holds the others: it is tried on the next pass.
    const isolated = (attempts: string, step: Effect.Effect<void, BoardTaskExecutionError>) =>
      step.pipe(
        Effect.catch((error) =>
          Effect.logWarning("A board task's engine step did not advance.", {
            task: taskId,
            attempts,
            cause: error.message,
          }),
        ),
      );
    const seats: Array<{ record: NativeAttempt; plan: Plan }> = [];
    for (const record of records) {
      const plan = yield* planOf(record, shell.thread.modelSelection, lineup);
      // A step claimed as a turn stays one after a restart, whatever the providers say now.
      if (plan.mode === "turn" || (record.lead && record.native?.threadId === threadId))
        yield* isolated(
          record.id,
          stepTurn(
            record,
            plan.mode === "turn" ? plan : { mode: "turn", modelSelection: undefined },
          ),
        );
      else seats.push({ record, plan });
    }
    yield* isolated(seats.map((entry) => entry.record.id).join(","), stepSeats(seats));
  });

  const reconcile = Effect.fn("BoardTaskExecution.reconcile")(
    function* () {
      const config = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
      if (config === null || !config.delivery.enabled) return;
      const environmentId = yield* identity.getEnvironmentId;
      const owner = `t3-board:${environmentId}`;
      const listed = yield* engine(delivery.read({ path: NATIVE_ATTEMPTS_PATH }));
      // An engine before native attempts v2 answers version 1, which is not this service's.
      const list = decodeList(listed.body);
      if (Option.isNone(list)) return;
      const byTask = new Map<string, Array<NativeAttempt>>();
      for (const { id } of list.value.pending) {
        if (!/^att-[A-Za-z0-9-]+$/.test(id)) continue;
        const record = yield* readAttempt(id).pipe(Effect.option);
        // Another coordinator's step, or one this build cannot read, is left alone.
        if (Option.isNone(record) || !TASK_ID.test(record.value.task)) continue;
        if (record.value.owner !== null && record.value.owner !== owner) continue;
        byTask.set(record.value.task, [...(byTask.get(record.value.task) ?? []), record.value]);
      }
      for (const [taskId, records] of byTask) {
        // One task's step never stops the pass: it is tried again on the next one.
        const result = yield* reconcileTask(taskId, records, environmentId, owner).pipe(
          Effect.result,
        );
        if (result._tag === "Failure")
          yield* Effect.logWarning("A board task's engine step did not advance.", {
            task: taskId,
            cause: result.failure.message,
          });
      }
    },
    (effect) => lock.withPermits(1)(effect),
  );

  const pass = reconcile().pipe(
    Effect.catchCause(() =>
      Effect.logDebug("Board task steps were not reconciled; the engine keeps its attempts."),
    ),
  );
  const start = Effect.fn("BoardTaskExecution.start")(function* () {
    // A turn or seat that ends on a task thread is reported at once; the beat is the claim's
    // heartbeat and the catch-up after a restart of T3 or of the engine.
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        isBoardTaskThreadId(event.threadId) &&
        (event.type === "run.updated" || event.type === "subagent.updated") &&
        TERMINAL_RUN.has(event.payload.status)
          ? pass
          : Effect.void,
      ),
    );
    yield* forkParked(pass.pipe(Effect.repeat(Schedule.spaced("30 seconds"))));
  });
  return BoardTaskExecution.of({ reconcile, start });
});

export const layer = Layer.effect(BoardTaskExecution, make);
