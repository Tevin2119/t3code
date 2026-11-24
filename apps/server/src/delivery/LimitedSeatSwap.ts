import {
  CommandId,
  DELIVERY_HARNESS_BY_DRIVER,
  DeliveryError,
  DeliveryLeadPickResult,
  type DeliveryLimitedSeatNotice,
  deliveryLimitedSeatPolicy,
  type DeliveryLimitedSeatStatus,
  type DeliveryLimitedSeatSwapInput,
  type DeliveryLimitedSeatSwapResult,
  type DeliveryOrchestrationConfig,
  isServerOwnedThreadLineage,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  agreedStandIn,
  firstFreeFavorite,
  isFreeCandidate,
  limitedLeadHandoffThreadId,
  limitedLeadPool,
  limitedSeatPool,
  seatLimit,
  seatModelOf,
  type SeatModel,
} from "@t3tools/shared/limitedSeat";
import { createModelSelection } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { createBoardTaskThread, type BoardTask } from "./boardThreadMarker.ts";
import * as BoardThreadRows from "./boardThreadRows.ts";
import * as DeliveryService from "./DeliveryService.ts";
import * as LimitedSeats from "./LimitedSeats.ts";
import { resolveSeatProvider } from "./seatProvider.ts";

/** What a lead handed on to a new thread is told, as limit recovery tells a thread it resumes. */
export const LEAD_HANDOFF_MESSAGE = "Continue where you left off.";

export const leadHandoffThreadId = limitedLeadHandoffThreadId;

const handoffIdentity = (threadId: ThreadId, runId: RunId) => `limited-lead:${threadId}:${runId}`;

const disarmLead = (threadId: ThreadId, runId: RunId, resetAt: string) =>
  ({
    type: "thread.metadata.update",
    commandId: CommandId.make(`${handoffIdentity(threadId, runId)}:disarm`),
    threadId,
    limitRecovery: { runId, resetAt, autoResume: false, snooze: false },
  }) satisfies OrchestrationV2ServerCommand;

/**
 * What hands a limited lead on, in order. The old thread's resume is disarmed first, so the same
 * work is never run twice and a refusal creates nothing; then the fork, then its first turn on
 * the substitute, which carries the handoff summary. Every id follows from the failed run.
 */
export function leadHandoffCommands(input: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly runId: RunId;
  /** The reset the old thread would resume at; null when there is none to disarm. */
  readonly resetAt: string | null;
  readonly substitute: ModelSelection;
}): ReadonlyArray<OrchestrationV2ServerCommand> {
  const identity = handoffIdentity(input.threadId, input.runId);
  const target = leadHandoffThreadId(input.runId);
  return [
    ...(input.resetAt === null ? [] : [disarmLead(input.threadId, input.runId, input.resetAt)]),
    {
      type: "thread.fork",
      commandId: CommandId.make(`${identity}:fork`),
      sourceThreadId: input.threadId,
      targetThreadId: target,
      sourcePoint: { type: "run", runId: input.runId },
      title: input.title,
      createdBy: "system",
      creationSource: "server",
    },
    {
      type: "message.dispatch",
      commandId: CommandId.make(`${identity}:continue`),
      messageId: MessageId.make(`${identity}:continue`),
      threadId: target,
      text: LEAD_HANDOFF_MESSAGE,
      attachments: [],
      modelSelection: input.substitute,
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
    },
  ];
}

export class LimitedSeatSwap extends Context.Service<
  LimitedSeatSwap,
  {
    readonly status: (
      threadId: ThreadId,
    ) => Effect.Effect<DeliveryLimitedSeatStatus, DeliveryError>;
    /** One click of the notice. Repeating it changes nothing and starts nothing twice. */
    readonly swap: (
      input: DeliveryLimitedSeatSwapInput,
    ) => Effect.Effect<DeliveryLimitedSeatSwapResult, DeliveryError>;
    /**
     * Hands a limited lead on when its conversation swaps automatically. Null where there is
     * nothing to hand on: no limit, another setting, or no free favorite.
     */
    readonly handOffLimitedLead: (threadId: ThreadId) => Effect.Effect<ThreadId | null>;
    readonly resumeBoardLeadHandoff: (
      task: BoardTask,
      shell: OrchestrationV2ThreadShell,
      runId: RunId,
    ) => Effect.Effect<typeof DeliveryService.BoardThreadLink.Type | null, DeliveryError>;
  }
>()("t3/delivery/LimitedSeatSwap") {}

const refused = (detail: string) => new DeliveryError({ reason: "invalid", detail });
const storage = (cause: unknown) =>
  new DeliveryError({
    reason: "storage",
    detail:
      cause instanceof Error
        ? cause.message || "Thread state could not be read."
        : "Thread state could not be read.",
  });

/** The usage limit a thread's latest run failed on, while it has not reset. */
function leadLimit(shell: OrchestrationV2ThreadShell, now: number) {
  if (
    shell.status !== "failed" ||
    shell.lastErrorClass !== "usage_limit" ||
    shell.latestRunId === null ||
    shell.archivedAt !== null ||
    (shell.usageLimitResetAt != null && Date.parse(shell.usageLimitResetAt) <= now)
  )
    return null;
  return {
    runId: shell.latestRunId,
    limited: { ...seatModelOf(shell.modelSelection), resetAt: shell.usageLimitResetAt ?? null },
  };
}

const selectionOf = (model: SeatModel): ModelSelection =>
  createModelSelection(model.instanceId, model.model);

const decodeBoardTaskDetail = Schema.decodeUnknownEffect(
  Schema.Struct({
    boardThread: Schema.optional(Schema.NullOr(DeliveryService.BoardThreadLink)),
    title: Schema.String,
    body: Schema.String,
    acceptance: Schema.Array(Schema.String),
    card: Schema.optional(
      Schema.Struct({
        run: Schema.optional(
          Schema.NullOr(Schema.Struct({ id: Schema.String, stage: Schema.String })),
        ),
      }),
    ),
  }),
);
const decodeBoardThreadLink = Schema.decodeUnknownEffect(
  Schema.Struct({ boardThread: DeliveryService.BoardThreadLink }),
);
const decodeLeadPick = Schema.decodeUnknownEffect(DeliveryLeadPickResult);
const decodePickRefusal = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));

const make = Effect.gen(function* () {
  const deliveryOption = yield* Effect.serviceOption(DeliveryService.DeliveryService);
  const identityOption = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironmentIdentity);
  const hostEnvironment = yield* HostProcess.Environment;
  const limitedSeats = yield* LimitedSeats.LimitedSeats;
  const rows = yield* BoardThreadRows.BoardThreadRows;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  /** The conversation as this setting governs it, or null where it does not. */
  const governed = Effect.fn("LimitedSeatSwap.governed")(function* (
    threadId: ThreadId,
    knownShell?: OrchestrationV2ThreadShell,
  ) {
    if (Option.isNone(deliveryOption)) return null;
    const shell =
      knownShell ?? (yield* projections.getThreadShell(threadId).pipe(Effect.mapError(storage)));
    if (
      shell === null ||
      isServerOwnedThreadLineage(shell.lineage) ||
      shell.lineage.relationshipToParent === "subagent" ||
      shell.lineage.sideChat === true
    )
      return null;
    const state = yield* deliveryOption.value.threadState(threadId);
    if (state.lineup === undefined) return null;
    return {
      delivery: deliveryOption.value,
      shell,
      state,
      lineup: state.lineup,
      facts: yield* limitedSeats.facts(threadId),
    };
  });

  /**
   * The thread a limited run was handed on to, with the model the hand-off started it on. The
   * fork carries its source's model until that first turn lands, so the thread's own model is
   * not the substitute. Null where the run was not handed on, or the thread was deleted since.
   */
  const handedOn = Effect.fn("LimitedSeatSwap.handedOn")(function* (runId: RunId) {
    const target = leadHandoffThreadId(runId);
    const continued = yield* projections.findThread(target);
    if (continued === null) return null;
    const { runs } = yield* projections.getThreadRecords(target, ["runs"]);
    return {
      id: continued.id,
      deleted: continued.deletedAt !== null,
      dispatched: runs[0]?.modelSelection ?? null,
    };
  }, Effect.mapError(storage));

  const status: LimitedSeatSwap["Service"]["status"] = Effect.fn("LimitedSeatSwap.status")(
    function* (threadId) {
      const conversation = yield* governed(threadId);
      if (conversation === null) return { policy: null, notices: [] };
      const { shell, lineup, facts } = conversation;
      const policy = deliveryLimitedSeatPolicy(lineup);
      const notices: Array<DeliveryLimitedSeatNotice> = [];
      const lead = leadLimit(shell, facts.now);
      if (lead !== null) {
        const continued = yield* handedOn(lead.runId);
        const free = firstFreeFavorite(
          limitedLeadPool({ facts, roster: lineup.participants, lead: shell.modelSelection }),
        );
        if (continued !== null && !continued.deleted) {
          // Between the fork and its first turn, the substitute is the one about to be started.
          const substitute = continued.dispatched ?? (free === null ? null : selectionOf(free));
          if (substitute !== null)
            notices.push({
              seat: null,
              limited: lead.limited,
              state: "swapped",
              substitute,
              continuedIn: continued.id,
            });
          // This thread runs no more turns, so its seats have nothing left to swap for.
          return { policy, notices };
        }
        // A deleted continuation cannot be made again; the recovery banner's resume is the way on.
        if (continued === null && policy !== "skip") {
          notices.push({
            seat: null,
            limited: lead.limited,
            state: free === null ? "none-free" : "offered",
            substitute: free === null ? null : selectionOf(free),
          });
        }
      }
      if (policy !== "skip") {
        for (const seat of lineup.participants) {
          const limit = seatLimit(facts, seatModelOf(seat.modelSelection));
          if (limit === null) continue;
          const pool = limitedSeatPool({
            facts,
            roster: lineup.participants,
            lead: shell.modelSelection,
            seat,
            runsOn: (other) =>
              agreedStandIn({ facts, policy, seat: other }) ?? other.modelSelection,
          });
          const limited = {
            instanceId: limit.instanceId,
            model: limit.model,
            resetAt: limit.resetAt,
          };
          const free = firstFreeFavorite(pool);
          const asks = policy === "ask" || seat.picked === true;
          if (asks && seat.substitute && isFreeCandidate(pool, seatModelOf(seat.substitute))) {
            notices.push({
              seat: seat.seat,
              limited,
              state: "swapped",
              substitute: seat.substitute,
            });
          } else if (free === null) {
            notices.push({ seat: seat.seat, limited, state: "none-free", substitute: null });
          } else if (asks) {
            notices.push({
              seat: seat.seat,
              limited,
              state: "offered",
              substitute: selectionOf(free),
            });
          }
        }
      }
      return { policy, notices };
    },
  );

  const handOffLead = Effect.fn("LimitedSeatSwap.handOffLead")(function* (
    conversation: NonNullable<Effect.Success<ReturnType<typeof governed>>>,
    /** The model a person clicked; absent, the first free favorite. */
    chosen: ModelSelection | undefined,
  ) {
    const { delivery, shell, state, lineup, facts } = conversation;
    const lead = leadLimit(shell, facts.now);
    if (lead === null) return yield* refused("This conversation's lead is not limited now.");
    const target = leadHandoffThreadId(lead.runId);
    const existing = yield* handedOn(lead.runId);
    if (existing?.deleted === true)
      return yield* refused(
        "The thread this conversation continued in was deleted. Resume this one at its reset.",
      );
    const pool = limitedLeadPool({
      facts,
      roster: lineup.participants,
      lead: shell.modelSelection,
    });
    const free = firstFreeFavorite(pool);
    // A hand-off already started keeps its model: a second click or sweep only finishes it.
    const substitute =
      existing !== null && existing.dispatched !== null
        ? existing.dispatched
        : chosen !== undefined
          ? isFreeCandidate(pool, seatModelOf(chosen))
            ? chosen
            : yield* refused(`${chosen.model} is no longer free. Choose again from the notice.`)
          : free === null
            ? yield* refused("No favorite model is free.")
            : selectionOf(free);
    const dispatch = (command: Parameters<typeof threads.dispatch>[0]) =>
      threads
        .dispatch(command)
        .pipe(
          Effect.mapError(
            (cause) =>
              new DeliveryError({ reason: "refused", detail: cause.message || "Refused." }),
          ),
        );
    // The team's roles and tools are bound to the thread before it exists, as a seat's are.
    const targetState = yield* delivery.threadState(target);
    if (state.binding !== null && targetState.binding === null) {
      const adapter = yield* adapters
        .get(substitute.instanceId)
        .pipe(Effect.mapError(() => refused(`${substitute.model}'s provider is unavailable.`)));
      yield* delivery.bindThread({
        threadId: target,
        team: state.binding.team,
        role: state.binding.role,
        driver: adapter.driver,
        cwd: state.binding.workspace,
        orchestration: lineup,
      });
    } else if (state.binding === null && targetState.lineup === undefined) {
      yield* delivery.setThreadLineup({ threadId: target, orchestration: lineup });
    }
    for (const command of leadHandoffCommands({
      threadId: shell.id,
      title: shell.title,
      runId: lead.runId,
      // Nothing to disarm when no reset is known, or a person already turned the resume off.
      resetAt:
        shell.limitRecovery?.runId === lead.runId && shell.limitRecovery.autoResume === false
          ? null
          : lead.limited.resetAt,
      substitute,
    }))
      yield* dispatch(command);
    return target;
  });

  const handOffBoardLead = Effect.fn("LimitedSeatSwap.handOffBoardLead")(function* (
    task: BoardTask,
    shell: OrchestrationV2ThreadShell,
    runId: RunId,
    resetAt: string | null,
    resuming: boolean,
  ) {
    const key = hostEnvironment[DeliveryService.BOARD_THREAD_KEY_VARIABLE];
    if ((!key && !resuming) || Option.isNone(deliveryOption) || Option.isNone(identityOption))
      return null;
    const delivery = deliveryOption.value;
    const environmentId = yield* identityOption.value.getEnvironmentId;
    const target = leadHandoffThreadId(runId);
    const path = `/api/tasks/${task.id}`;
    const response = yield* delivery.read({ path });
    const detail = yield* decodeBoardTaskDetail(response.body);
    const previous = detail.boardThread;
    if (previous?.environmentId !== environmentId) return null;
    const alreadyLinked = previous.threadId === target;
    if (alreadyLinked ? !resuming : !key || previous.threadId !== shell.id) return null;

    const identity = handoffIdentity(shell.id, runId);
    const existing = yield* projections.findThread(target);
    let modelSelection: ModelSelection;
    if (existing !== null) {
      if (existing.deletedAt !== null || existing.archivedAt !== null) return null;
      const row = (yield* rows.list({ archived: false })).find((row) => row.threadId === target);
      if (row?.task.id !== task.id || row.task.board !== task.board) return null;
      modelSelection = existing.modelSelection;
    } else {
      if (resuming) return null;
      const { runs } = yield* projections.getThreadRecords(shell.id, ["runs"], {
        runIds: [runId],
      });
      const failed = runs[0]?.modelSelection;
      if (failed === undefined) return null;
      const provider = yield* adapters.get(failed.instanceId);
      const harness = DELIVERY_HARNESS_BY_DRIVER[provider.driver];
      if (harness === undefined) return null;
      const answer = yield* delivery
        .boardThreadAct({
          method: "POST",
          path: `${path}/lead-pick`,
          body: {
            limited: { harness, model: failed.model },
            reason: "usage-limit",
            setBy: environmentId,
            key,
          },
        })
        .pipe(Effect.result);
      if (answer._tag === "Failure") {
        const refusal = decodePickRefusal(answer.failure.body);
        if (
          Option.isSome(refusal) &&
          ["none-free", "moved", "refused", "not-found"].includes(refusal.value.code)
        )
          return null;
        return yield* answer.failure;
      }
      const { leadPick } = yield* decodeLeadPick(answer.success.body);
      if (leadPick === undefined) return null;
      const instance = resolveSeatProvider(
        (yield* instances.listInstances).filter((entry) => entry.enabled),
        leadPick.harness,
        (entry) => entry.instanceId,
      );
      if (typeof instance === "string")
        return yield* refused("The board lead's picked provider is unavailable.");
      modelSelection = createModelSelection(instance.instanceId, leadPick.model);
      yield* threads.dispatch(
        createBoardTaskThread(task, {
          commandId: CommandId.make(`${identity}:thread`),
          threadId: target,
          projectId: shell.projectId,
          title: detail.title,
          modelSelection,
        }),
      );
    }

    const messageId = MessageId.make(`${identity}:continue`);
    const continuation =
      existing === null
        ? undefined
        : (yield* projections.getMessagesById(target, [messageId])).get(messageId);
    if (!alreadyLinked && continuation !== undefined) {
      const current = yield* projections.getThreadShell(shell.id);
      const newerUserTurn = current?.latestUserAuthoredMessageAt;
      if (
        current?.latestRunId !== runId ||
        (newerUserTurn != null && DateTime.isGreaterThan(newerUserTurn, continuation.createdAt))
      )
        return previous;
    }
    if (
      resetAt !== null &&
      !(shell.limitRecovery?.runId === runId && shell.limitRecovery.autoResume === false)
    )
      yield* threads.dispatch(disarmLead(shell.id, runId, resetAt));
    if (continuation === undefined) {
      const run = detail.card?.run;
      const summary = [
        "Continue this board task. The previous lead hit a usage limit.",
        `# ${detail.title}`,
        detail.body,
        ...(detail.acceptance.length === 0
          ? []
          : ["## Acceptance", detail.acceptance.map((item) => `- ${item}`).join("\n")]),
        run ? `Engine run ${run.id}, stage ${run.stage}.` : "No current engine run.",
      ];
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${identity}:continue`),
        messageId,
        threadId: target,
        text: summary.join("\n\n"),
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
      });
    }
    if (alreadyLinked) return previous;
    const linked = yield* delivery.boardThreadAct({
      method: "PUT",
      path: `${path}/board-thread`,
      body: { environmentId, threadId: target, setBy: environmentId, expect: previous, key },
    });
    return (yield* decodeBoardThreadLink(linked.body)).boardThread;
  });

  const resumeBoardLeadHandoff: LimitedSeatSwap["Service"]["resumeBoardLeadHandoff"] = Effect.fn(
    "LimitedSeatSwap.resumeBoardLeadHandoff",
  )(
    (task, shell, runId) =>
      handOffBoardLead(task, shell, runId, shell.usageLimitResetAt ?? null, true),
    Effect.mapError((cause) => (Schema.is(DeliveryError)(cause) ? cause : storage(cause))),
  );

  const swap: LimitedSeatSwap["Service"]["swap"] = Effect.fn("LimitedSeatSwap.swap")(
    function* (input) {
      const conversation = yield* governed(input.threadId);
      if (conversation === null)
        return yield* refused("This conversation has no setting for a limited seat.");
      if (input.seat === null)
        return { continuedIn: yield* handOffLead(conversation, input.modelSelection) };
      const { delivery, shell, lineup, facts } = conversation;
      const seat = lineup.participants.find((candidate) => candidate.seat === input.seat);
      if (seat === undefined) return yield* refused(`${input.seat} is not in this conversation.`);
      const chosen = seatModelOf(input.modelSelection);
      const agreed = seat.substitute;
      if (agreed?.instanceId === chosen.instanceId && agreed.model === chosen.model)
        return { continuedIn: null };
      if (seatLimit(facts, seatModelOf(seat.modelSelection)) === null)
        return yield* refused(`${input.seat} is not limited now.`);
      const policy = deliveryLimitedSeatPolicy(lineup);
      const pool = limitedSeatPool({
        facts,
        roster: lineup.participants,
        lead: shell.modelSelection,
        seat,
        runsOn: (other) => agreedStandIn({ facts, policy, seat: other }) ?? other.modelSelection,
      });
      if (!isFreeCandidate(pool, chosen))
        return yield* refused(`${chosen.model} is no longer free. Choose again from the notice.`);
      const orchestration: DeliveryOrchestrationConfig = {
        ...lineup,
        participants: lineup.participants.map((candidate) =>
          candidate.seat === seat.seat
            ? { ...candidate, substitute: input.modelSelection }
            : candidate,
        ),
      };
      yield* delivery.setThreadLineup({ threadId: input.threadId, orchestration });
      return { continuedIn: null };
    },
  );

  const handOffLimitedLead: LimitedSeatSwap["Service"]["handOffLimitedLead"] = Effect.fn(
    "LimitedSeatSwap.handOffLimitedLead",
  )(
    function* (threadId) {
      if (Option.isNone(deliveryOption)) return null;
      const shell = yield* projections.getThreadShell(threadId);
      if (shell === null) return null;
      const row = (yield* rows.list({ archived: false })).find((row) => row.threadId === shell.id);
      if (row !== undefined) {
        const lead = leadLimit(shell, (yield* DateTime.now).epochMilliseconds);
        if (lead === null) return null;
        const link = yield* handOffBoardLead(
          row.task,
          shell,
          lead.runId,
          lead.limited.resetAt,
          false,
        );
        const target = leadHandoffThreadId(lead.runId);
        return link?.threadId === target ? target : null;
      }
      const conversation = yield* governed(threadId, shell);
      if (
        conversation === null ||
        deliveryLimitedSeatPolicy(conversation.lineup) !== "swap" ||
        leadLimit(conversation.shell, conversation.facts.now) === null
      )
        return null;
      return yield* handOffLead(conversation, undefined);
    },
    // No free favorite, or a refusal: the thread stays as it failed, with its notice.
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logInfo("limited-seats.lead-not-handed-on", { threadId, cause }).pipe(
            Effect.as(null),
          ),
        ),
      ),
  );

  return LimitedSeatSwap.of({ status, swap, handOffLimitedLead, resumeBoardLeadHandoff });
});

export const layer = Layer.effect(LimitedSeatSwap, make);

/** Hands a limited lead on as soon as its turn fails, where the conversation swaps automatically. */
export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const swaps = yield* LimitedSeatSwap;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        // The failure and its usage-limit error are separate events, in either order.
        (event.type === "run.updated" && event.payload.status === "failed") ||
        (event.type === "turn-item.updated" && event.payload.type === "error")
          ? swaps.handOffLimitedLead(event.threadId)
          : Effect.void,
      ),
    );
  }),
);
