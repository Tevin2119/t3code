// The engine's model steps of a board task, run inside the task's T3 thread. The engine stays the
// referee: it schedules, caps and gates, and queues each step as a native attempt v2. T3 runs each
// one as a turn or a subagent of the thread and reports its answer. Nothing here decides a step or
// switches a board's execution.
import {
  CommandId,
  DELIVERY_HARNESS_BY_DRIVER,
  type EnvironmentId,
  latestProviderTurnForAttempt,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2EngineStageSeat,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
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
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import {
  briefAttemptOf,
  briefMessageId,
  briefSetupCommandId,
  engineStageNotice,
  isEngineStageMessageId,
  isTerminalAttempt,
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
import * as BoardThreadRows from "./boardThreadRows.ts";
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
const terminalRun = (run: { readonly status: string }) => TERMINAL_RUN.has(run.status);
const ACTIVE_RUN = new Set(["preparing", "starting", "running", "waiting"]);
const terminalTask = (task: OrchestrationV2Subagent) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(task.status);
/** A terminal run or subagent as the engine's terminal states name it. */
const attemptState = (status: string) =>
  status === "completed" || status === "failed" || status === "interrupted" ? status : "cancelled";
/** Cancelled without the engine asking, as T3's own restart recovery cancels a step. */
const unaskedCancel = (record: Pick<NativeAttempt, "cancelRequested">, state: string) =>
  state === "cancelled" && !record.cancelRequested;
/** The engine's name for a driver; a driver it has no name for is told by its own. */
const harnessOf = (driver: ProviderDriverKind | string | undefined) =>
  driver === undefined ? null : (DELIVERY_HARNESS_BY_DRIVER[driver] ?? driver);
/** The model the provider reported running a run's turn. None reported is none known. */
const ranModel = (
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  run: Pick<OrchestrationV2Run, "activeAttemptId"> | undefined,
) =>
  run === undefined
    ? null
    : (latestProviderTurnForAttempt(providerTurns, run.activeAttemptId)?.model ?? null);

/**
 * How a step runs here. The team plan is a turn of the task thread, which the team round needs;
 * every other step is a subagent of it, in the engine's worktree and with the step's access.
 */
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
  const rows = yield* BoardThreadRows.BoardThreadRows;
  const launch = yield* ThreadLaunchService.ThreadLaunchService;
  const ids = yield* IdAllocator.IdAllocatorV2;
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
      .getThreadRecords(threadId, ["runs", "subagents", "providerTurns"])
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
    const here = providers.find((provider) => provider.instanceId === current.instanceId);
    const onThreadHarness = harnessOf(here?.driverKind) === record.harness;
    if (record.kind === "team-plan") {
      // Another model of the thread's account family: the turn switches model in place. On
      // another harness the brief keeps the thread's model, and reports what it ran.
      const switched =
        record.model === null
          ? undefined
          : turnSelection(providers, current, { harness: record.harness, model: record.model });
      return { mode: "turn", modelSelection: switched } as Plan;
    }
    const provider = resolveSeatProvider(
      providers.filter((entry) => entry.enabled),
      record.harness,
      (entry) => entry.instanceId,
      onThreadHarness ? current.instanceId : undefined,
    );
    if (typeof provider === "string") return { mode: "unavailable", why: provider } as Plan;
    // A null model is the harness's own default: the seat's pick in the thread's team, or for
    // the lead the model its thread runs on.
    const model =
      record.model ??
      (record.lead && onThreadHarness ? current.model : undefined) ??
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

  /**
   * A run's final answer: its last completed assistant item, as a child's final answer is read
   * for a native build, else its last assistant message.
   */
  const lastReply = Effect.fn("BoardTaskExecution.lastReply")(function* (
    threadId: ThreadId,
    runId: OrchestrationV2Run["id"],
  ) {
    const records = yield* local(
      projections.getThreadRecords(threadId, ["turnItems", "messages"], {
        turnItemRunId: runId,
        messageRunIds: [runId],
      }),
    );
    const item = (records.turnItems ?? [])
      .filter(
        (candidate) =>
          candidate.type === "assistant_message" &&
          candidate.runId === runId &&
          candidate.status === "completed",
      )
      .toSorted((a, b) => a.ordinal - b.ordinal)
      .at(-1);
    if (item?.type === "assistant_message" && item.text.trim()) return item.text;
    return (
      records.messages
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
   * What a child did: its final answer, and the model and harness that ran its latest run, as
   * its provider turn reported them. The engine judges QA independence by that identity and fails
   * closed without one, so a model the provider did not report is left out, never guessed.
   */
  const childOutcome = Effect.fn("BoardTaskExecution.childOutcome")(function* (
    task: OrchestrationV2Subagent,
  ) {
    const child =
      task.childThreadId === null
        ? Option.none()
        : yield* projections
            .getThreadRecords(task.childThreadId, ["runs", "providerTurns"])
            .pipe(Effect.option);
    const latest = Option.isSome(child)
      ? child.value.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]
      : undefined;
    const text =
      latest === undefined || task.childThreadId === null
        ? ""
        : yield* lastReply(task.childThreadId, latest.id);
    const model = Option.isSome(child) ? ranModel(child.value.providerTurns, latest) : null;
    return {
      text: (text.trim() ? text : (task.result ?? "")).slice(0, TEXT_LIMIT),
      model,
      harness: model === null ? null : yield* harnessOfInstance(latest?.providerInstanceId),
    };
  });

  /**
   * Gives a task thread back the folder and mode it was made with, once no run is active in it.
   * What is owed is the thread's own record: a brief that moved it left its setup command's
   * receipt and no matching give-back. That record outlives the attempt, which the engine stops
   * listing once it is complete, and a restart of this server; so every pass retries it here.
   */
  const restoreThread = Effect.fn("BoardTaskExecution.restoreThread")(function* (
    threadId: ThreadId,
  ) {
    const records = yield* local(projections.getThreadRecords(threadId, ["runs"]));
    const { thread, runs } = records;
    if (thread.worktreePath === null && thread.runtimeMode === "full-access") return;
    // Moving a thread's folder ends its provider sessions, so it waits for an idle thread.
    if (runs.some((run) => ACTIVE_RUN.has(run.status))) return;
    for (const run of runs) {
      const attemptId = briefAttemptOf(run.userMessageId);
      if (attemptId === null || !terminalRun(run)) continue;
      const owed = (step: "folder" | "mode", back: "folder-back" | "mode-back") =>
        Effect.all([
          threads.hasReceipt(briefSetupCommandId(attemptId, step)),
          threads.hasReceipt(briefSetupCommandId(attemptId, back)),
        ]).pipe(Effect.map(([set, given]) => set && !given));
      if (yield* owed("folder", "folder-back"))
        yield* local(
          threads.dispatch({
            type: "thread.metadata.update",
            commandId: briefSetupCommandId(attemptId, "folder-back"),
            threadId,
            worktreePath: null,
          }),
        );
      if (yield* owed("mode", "mode-back"))
        yield* local(
          threads.dispatch({
            type: "thread.runtime-mode.set",
            commandId: briefSetupCommandId(attemptId, "mode-back"),
            threadId,
            runtimeMode: "full-access",
          }),
        );
    }
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
      local(projections.getThreadRecords(threadId, ["runs", "subagents", "providerTurns"])),
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
    const idle = () => !shell.runs.some((run) => ACTIVE_RUN.has(run.status));

    const claim = Effect.fn("BoardTaskExecution.claim")(function* (record: NativeAttempt) {
      // Without a live claim on the task no step advances here, one this server owns included:
      // the engine takes a step whose claim lapsed for abandoned.
      if (!held) return null;
      if (record.owner !== null) return record;
      // A step the engine stopped before it was claimed stays the engine's.
      if (record.cancelRequested) return null;
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
      const result = yield* attestSeatWith(delivery, {
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

    /**
     * A terminal step's report. No model or harness known is none reported: the engine decides.
     * Reported with the true reason: a step the engine asked to stop that neither completed nor
     * failed is cancelled, however T3 stopped it. A cancel it never asked for, as T3's restart
     * recovery makes, is interrupted, with no identity, since nothing finished on it.
     */
    const complete = (
      record: NativeAttempt,
      receipt: { readonly threadId: ThreadId } | { readonly childThreadId: ThreadId },
      result: {
        readonly state: string;
        readonly text: string;
        readonly reason?: string | null;
        readonly model?: string | null;
        readonly harness?: string | null;
        readonly contributions?: ReadonlyArray<unknown>;
      },
    ) => {
      const unasked = unaskedCancel(record, result.state);
      const state = unasked
        ? "interrupted"
        : record.cancelRequested && result.state !== "completed" && result.state !== "failed"
          ? "cancelled"
          : result.state;
      return act(record, "complete", {
        owner,
        ...receipt,
        state,
        text: result.text.slice(0, TEXT_LIMIT),
        reason: unasked
          ? "T3 stopped this step before it finished, as a restart does; the engine did not ask."
          : (result.reason ?? (state === "completed" ? null : `Ended ${state}.`)),
        ...(result.model && !unasked ? { model: result.model } : {}),
        ...(result.harness && !unasked ? { harness: result.harness } : {}),
        ...(result.contributions === undefined ? {} : { contributions: result.contributions }),
      }).pipe(Effect.tap(() => Effect.sync(() => attested.delete(record.id))));
    };

    /** Stops a turn the engine no longer wants: a queued one is cancelled, a live one interrupted. */
    const stopRun = (
      attemptId: string,
      run: OrchestrationV2Run,
      queued: "cancel-queued" | "cancel-stage" = "cancel-queued",
    ) =>
      run.status === "queued"
        ? local(
            threads.dispatch({
              type: "queued-run.cancel",
              commandId: stopCommandId(attemptId, queued),
              threadId,
              runId: run.id,
            }),
          )
        : ACTIVE_RUN.has(run.status)
          ? local(
              threads.dispatch({
                type: "run.interrupt",
                commandId: stopCommandId(attemptId, "interrupt"),
                threadId,
                runId: run.id,
                reason: "The delivery engine asked to stop this step.",
              }),
            )
          : Effect.void;

    /**
     * The team plan: the brief, a turn of the task thread so its team round runs. The thread is
     * moved into the engine's worktree first, and a read-only plan runs in the mode that asks,
     * where TeamChatReadOnlyReactor declines every change. Both are given back after the plan.
     */
    const stepBrief = Effect.fn("BoardTaskExecution.stepBrief")(function* (
      record: NativeAttempt,
      plan: Extract<Plan, { mode: "turn" }>,
    ) {
      const messageId = briefMessageId(record.id);
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
          yield* complete(current, { threadId }, { state: "cancelled", text: "" });
          return;
        }
        const prompt = current.prompt?.trim();
        if (!prompt) return yield* new BoardTaskExecutionError({ reason: "engine" });
        // Moving a thread's folder ends its provider sessions, so it waits for an idle thread.
        if (!idle()) return;
        if (shell.thread.worktreePath !== current.worktree)
          yield* local(
            threads.dispatch({
              type: "thread.metadata.update",
              commandId: briefSetupCommandId(current.id, "folder"),
              threadId,
              worktreePath: current.worktree,
            }),
          );
        if (current.access === "read-only" && shell.thread.runtimeMode !== "approval-required")
          yield* local(
            threads.dispatch({
              type: "thread.runtime-mode.set",
              commandId: briefSetupCommandId(current.id, "mode"),
              threadId,
              runtimeMode: "approval-required",
            }),
          );
        yield* local(
          threads.dispatch({
            type: "message.dispatch",
            commandId: turnCommandId(messageId),
            threadId,
            messageId,
            text: briefText(detail, prompt),
            attachments: [],
            ...(plan.modelSelection === undefined ? {} : { modelSelection: plan.modelSelection }),
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
      // What the turn ran on, as its provider turn reports it, and nothing when it reports none.
      const model = ranModel(shell.providerTurns, run);
      const harness = model === null ? null : yield* harnessOfInstance(run.providerInstanceId);
      if (!terminalRun(run)) {
        if (current.cancelRequested) yield* stopRun(current.id, run);
        // The lead's turn is attested as it runs, so its seat counts for the current run.
        else yield* attest(current, threadId, model, harness);
        return;
      }
      const children = shell.subagents.filter(
        (task) => task.runId === run.id || task.teamChat?.sourceRunId === run.id,
      );
      if (children.some((task) => !terminalTask(task))) return;
      const participants = current.participants ?? [];
      const contributions: Array<Record<string, unknown>> = [];
      for (const task of children) {
        const seat = task.teamChat?.seat;
        if (
          task.teamChat?.stage !== "contribution" ||
          seat === undefined ||
          !participants.some((entry) => entry.seat === seat) ||
          task.childThreadId === null
        )
          continue;
        const outcome = yield* childOutcome(task);
        contributions.push({
          seat,
          childThreadId: task.childThreadId,
          // What the seat's child really ran on, as for any seat.
          ...(outcome.model ? { model: outcome.model } : {}),
          ...(outcome.harness ? { harness: outcome.harness } : {}),
          state: attemptState(task.status),
          text: outcome.text.slice(0, 25_000),
        });
      }
      // The thread is given back its folder and mode before the plan is told: now if it is
      // idle, else by a later pass, which reads what is owed from the thread itself.
      yield* restoreThread(threadId);
      yield* complete(
        current,
        { threadId },
        {
          state: attemptState(run.status),
          text: yield* lastReply(threadId, run.id),
          model,
          harness,
          contributions: contributions.slice(0, 32),
        },
      );
    });

    /**
     * Stops a seat's child as task_cancel stops a delegated task: the child thread and every task
     * under it, then the child's queued turns, which a stop keeps for a resume.
     */
    const stopSeat = Effect.fn("BoardTaskExecution.stopSeat")(function* (
      record: NativeAttempt,
      task: OrchestrationV2Subagent,
      childThreadId: ThreadId,
    ) {
      const commandId = stopCommandId(record.id, "stop-seat");
      const reason = "The delivery engine asked to stop this step.";
      yield* local(
        threads.cancelDelegatedTask({
          parentThreadId: threadId,
          taskId: task.id,
          command: {
            type: "thread.stop",
            commandId,
            threadId: childThreadId,
            stopDelegatedTasks: false,
            reason,
          },
          stopDescendants: (remoteDispatch) =>
            threads.stopDelegatedTasks({
              threadId: childThreadId,
              commandId,
              reason,
              remoteDispatch,
            }),
        }),
      );
      const child = yield* local(projections.getThreadRecords(childThreadId, ["runs"]));
      for (const run of child.runs) {
        if (run.status !== "queued" || run.delegatedTaskId !== task.id) continue;
        yield* local(
          threads.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`${commandId}:queued:${run.id}`),
            threadId: childThreadId,
            runId: run.id,
          }),
        );
      }
    });

    /** Every other step: subagents of one system turn per batch, in the engine's worktree. */
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
      // Each stage turn of this thread, with the seats it starts.
      const loadStages = Effect.fn("BoardTaskExecution.loadStages")(function* () {
        const stageRuns = shell.runs.filter((run) => isEngineStageMessageId(run.userMessageId));
        const stageMessages = yield* local(
          projections.getMessagesById(
            threadId,
            stageRuns.flatMap((run) => (run.userMessageId === null ? [] : [run.userMessageId])),
          ),
        );
        return (attemptId: string) => {
          for (const run of stageRuns) {
            const source = stageMessages.get(run.userMessageId as MessageId)?.notification?.source;
            if (
              source?.kind === "engine_stage" &&
              source.seats.some((seat) => seat.attemptId === attemptId)
            )
              return { run, seats: source.seats };
          }
          return undefined;
        };
      });
      const providers = yield* instances.listInstances;
      const attachSeat = Effect.fn("BoardTaskExecution.attachSeat")(function* (
        record: NativeAttempt,
        plan: Extract<Plan, { mode: "seat" }>,
      ) {
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
      });
      const sentIn = yield* loadStages();
      const batches = new Map<
        string,
        Array<{ record: NativeAttempt; plan: Extract<Plan, { mode: "seat" }> }>
      >();
      for (const { record, plan } of owned.filter((entry) => entry.record.native === null)) {
        // Already in a stage turn, its attach lost: attached to that turn, never sent again, so a
        // stage turn keeps the id it was sent with whatever seats are left.
        if (plan.mode === "seat" && sentIn(record.id) !== undefined) {
          yield* attachSeat(record, plan);
          continue;
        }
        // Claimed here before, and can no longer run here, or stopped before it was sent.
        if (plan.mode !== "seat" || record.cancelRequested) {
          const attached = yield* act(record, "attach", {
            owner,
            environmentId,
            ...receiptOf(record),
          });
          yield* complete(attached, receiptOf(record), {
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
            // The orchestrator takes a notification only as a queued agent message.
            createdBy: "agent",
            creationSource: "server",
          }),
        );
        for (const { record, plan } of sorted) yield* attachSeat(record, plan);
      }
      if (batches.size > 0) yield* refresh;
      const stageOf = batches.size > 0 ? yield* loadStages() : sentIn;
      const wanted = new Map(owned.map(({ record }) => [record.id, record]));

      for (const { record } of owned) {
        if (record.native === null || isTerminalAttempt(record.state)) continue;
        const child = childOf(record);
        const task = shell.subagents.find((candidate) => candidate.childThreadId === child);
        if (task !== undefined) {
          if (record.cancelRequested && !terminalTask(task) && task.childThreadId !== null) {
            yield* stopSeat(record, task, task.childThreadId);
            continue;
          }
          if (!terminalTask(task) && task.childThreadId !== null) {
            // The child waits in the engine's worktree until its run is prepared, which the
            // delegate tool asks of the launch service too. Asked on every pass, so a pass that
            // missed it prepares it later. A restart is not rescued here: boot recovery cancels
            // the preparing child, and complete() reports that as interrupted.
            const childRuns = yield* local(
              projections.getThreadRecords(task.childThreadId, ["runs"]),
            );
            for (const childRun of childRuns.runs)
              if (childRun.status === "preparing" && childRun.workspacePreparation !== undefined)
                yield* launch.prepareRun({
                  commandId: seatCommandId(threadId, record.id),
                  threadId: task.childThreadId,
                  runId: childRun.id,
                });
          }
          if (!terminalTask(task)) continue;
          const outcome = yield* childOutcome(task);
          // Attested again when the seat ran on something other than it was attested with.
          if (!unaskedCancel(record, attemptState(task.status)))
            yield* attest(record, child, outcome.model, outcome.harness);
          yield* complete(record, receiptOf(record), {
            state: attemptState(task.status),
            ...outcome,
          });
          continue;
        }
        // No child yet: it is started at its stage turn's start, or never.
        const stage = stageOf(record.id);
        if (stage === undefined) continue;
        if (record.cancelRequested && stage.run.status === "queued") {
          // A queued stage turn starts nothing once every seat it holds is stopped or done.
          const stopped = stage.seats.every((seat) => {
            const other = wanted.get(seat.attemptId);
            return other === undefined || other.cancelRequested;
          });
          if (stopped) yield* stopRun(stage.seats[0]!.attemptId, stage.run, "cancel-stage");
          continue;
        }
        // The stage turn is settled past its seats' start: a seat with no child never gets one.
        const settled = terminalRun(stage.run) || ["running", "waiting"].includes(stage.run.status);
        if (!settled) continue;
        yield* complete(record, receiptOf(record), {
          state: record.cancelRequested ? "cancelled" : "failed",
          text: "",
          reason: record.cancelRequested
            ? "Stopped before its subagent started."
            : `Its stage turn ended ${stage.run.status} before this seat's subagent started.`,
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
      if (plan.mode === "turn") yield* isolated(record.id, stepBrief(record, plan));
      else seats.push({ record, plan });
    }
    yield* isolated(seats.map((entry) => entry.record.id).join(","), stepSeats(seats));
  });

  const reconcile = Effect.fn("BoardTaskExecution.reconcile")(
    function* () {
      // Before the engine is asked anything: a thread is given back even while it is away.
      for (const row of yield* local(rows.list({ archived: false }))) {
        const restored = yield* restoreThread(row.threadId).pipe(Effect.result);
        if (restored._tag === "Failure")
          yield* Effect.logWarning("A board task thread was not given back its folder yet.", {
            thread: row.threadId,
            cause: restored.failure.message,
          });
      }
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
        (TERMINAL_RUN.has(event.payload.status) || event.payload.status === "running")
          ? pass
          : Effect.void,
      ),
    );
    yield* forkParked(pass.pipe(Effect.repeat(Schedule.spaced("30 seconds"))));
  });
  return BoardTaskExecution.of({ reconcile, start });
});

export const layer = Layer.effect(BoardTaskExecution, make);
