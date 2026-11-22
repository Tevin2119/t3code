import {
  CommandId,
  DeliveryError,
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
import {
  firstFreeFavorite,
  isFreeCandidate,
  limitedLeadPool,
  limitedSeatPool,
  seatLimit,
  seatModelOf,
  type SeatModel,
} from "@t3tools/shared/limitedSeat";
import { createModelSelection } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as DeliveryService from "./DeliveryService.ts";
import * as LimitedSeats from "./LimitedSeats.ts";

/** What a lead handed on to a new thread is told, as limit recovery tells a thread it resumes. */
export const LEAD_HANDOFF_MESSAGE = "Continue where you left off.";

/** The thread a limited lead's run is handed on to. One per run, however often it is asked for. */
export const leadHandoffThreadId = (runId: RunId) => ThreadId.make(`limited-lead:${runId}`);

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
  const identity = `limited-lead:${input.threadId}:${input.runId}`;
  const target = leadHandoffThreadId(input.runId);
  return [
    ...(input.resetAt === null
      ? []
      : [
          {
            type: "thread.metadata.update" as const,
            commandId: CommandId.make(`${identity}:disarm`),
            threadId: input.threadId,
            limitRecovery: {
              runId: input.runId,
              resetAt: input.resetAt,
              autoResume: false,
              snooze: false,
            },
          },
        ]),
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

const make = Effect.gen(function* () {
  const deliveryOption = yield* Effect.serviceOption(DeliveryService.DeliveryService);
  const limitedSeats = yield* LimitedSeats.LimitedSeats;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;

  /** The conversation as this setting governs it, or null where it does not. */
  const governed = Effect.fn("LimitedSeatSwap.governed")(function* (threadId: ThreadId) {
    if (Option.isNone(deliveryOption)) return null;
    const shell = yield* projections.getThreadShell(threadId).pipe(Effect.mapError(storage));
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

  const status: LimitedSeatSwap["Service"]["status"] = Effect.fn("LimitedSeatSwap.status")(
    function* (threadId) {
      const conversation = yield* governed(threadId);
      if (conversation === null) return { policy: null, notices: [] };
      const { shell, lineup, facts } = conversation;
      const policy = deliveryLimitedSeatPolicy(lineup);
      const notices: Array<DeliveryLimitedSeatNotice> = [];
      const lead = leadLimit(shell, facts.now);
      if (lead !== null) {
        const continued = yield* projections
          .findThread(leadHandoffThreadId(lead.runId))
          .pipe(Effect.mapError(storage));
        if (continued !== null) {
          notices.push({
            seat: null,
            limited: lead.limited,
            state: "swapped",
            substitute: continued.modelSelection,
            continuedIn: continued.id,
          });
        } else if (policy !== "skip") {
          const free = firstFreeFavorite(
            limitedLeadPool({ facts, roster: lineup.participants, lead: shell.modelSelection }),
          );
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
    const existing = yield* projections.findThread(target).pipe(Effect.mapError(storage));
    const pool = limitedLeadPool({
      facts,
      roster: lineup.participants,
      lead: shell.modelSelection,
    });
    const free = firstFreeFavorite(pool);
    // A hand-off already made keeps its model: a second click or sweep only finishes it.
    const substitute =
      existing !== null
        ? existing.modelSelection
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
      const pool = limitedSeatPool({
        facts,
        roster: lineup.participants,
        lead: shell.modelSelection,
        seat,
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
      const conversation = yield* governed(threadId);
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

  return LimitedSeatSwap.of({ status, swap, handOffLimitedLead });
});

export const layer = Layer.effect(LimitedSeatSwap, make);

/** Hands a limited lead on as soon as its turn fails, where the conversation swaps automatically. */
export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const swaps = yield* LimitedSeatSwap;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "failed"
          ? swaps.handOffLimitedLead(event.threadId)
          : Effect.void,
      ),
    );
  }),
);
