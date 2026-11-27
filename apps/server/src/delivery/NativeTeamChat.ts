import {
  CommandId,
  deliveryLimitedSeatPolicy,
  deliveryParticipantAccess,
  isCompactionCommandMessage,
  isServerOwnedThreadLineage,
  type MessageId,
  type ModelSelection,
  type NodeId,
  parseGoalCommand,
  type OrchestrationV2NotificationSource,
  type OrchestrationV2Subagent,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  agreedStandIn,
  firstFreeFavorite,
  isFreeCandidate,
  type LimitedSeatFacts,
  limitedSeatPool,
  seatLimit,
  type SeatModel,
  seatModelOf,
} from "@t3tools/shared/limitedSeat";
import { createModelSelection } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { runtimeModeProblem } from "@t3tools/provider-core/server/runtimeModeSupport";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  isBoardBriefMessageId,
  isEngineStageMessageId,
  isTerminalAttempt,
  NativeAttempt,
  nativeAttemptPath,
  seatCommandId,
} from "./boardTaskAttempts.ts";
import { boardTaskOfMarker, isBoardTaskThreadId } from "./boardThreadMarker.ts";

const decodeAttempt = Schema.decodeUnknownEffect(NativeAttempt);
import * as DeliveryService from "./DeliveryService.ts";
import * as LimitedSeats from "./LimitedSeats.ts";
import { teamDiscussionContext } from "./teamDiscussionContext.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

export class NativeTeamChatError extends Schema.TaggedError<NativeTeamChatError>()(
  "NativeTeamChatError",
  {
    runId: RunId,
    reason: Schema.Literals(["roster", "state", "dispatch"]),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.detail !== undefined) return this.detail;
    return this.reason === "roster"
      ? "Choose between two and twelve team participants with available providers."
      : "The native team discussion could not advance. Its recorded contributions are preserved.";
  }
}

export class NativeTeamChat extends Context.Service<
  NativeTeamChat,
  {
    readonly prepareTurn: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<{ readonly ready: boolean; readonly context: string }, NativeTeamChatError>;
  }
>()("t3/delivery/NativeTeamChat") {}

export const isNativeTeamChatError = Schema.is(NativeTeamChatError);

const terminal = (task: OrchestrationV2Subagent) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(task.status);

/**
 * A usage limit's reset as a turn note writes it. The server cannot know each reader's clock, so
 * the time is the server's own and names its zone.
 */
export const formatLimitReset = (resetAt: string) =>
  Option.match(DateTime.make(resetAt), {
    onNone: () => resetAt,
    onSome: (time) =>
      DateTime.toDate(time).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }),
  });

/** The name the model picker shows for a model; its id where the provider lists no name. */
const modelName = (facts: LimitedSeatFacts, model: SeatModel) =>
  facts.providers
    .find((provider) => provider.instanceId === model.instanceId)
    ?.models.find((candidate) => candidate.slug === model.model)?.name ?? model.model;

const contributions = (tasks: ReadonlyArray<OrchestrationV2Subagent>) =>
  tasks
    .map(
      (task) =>
        `${task.teamChat?.seat ?? task.title} (${task.providerInstanceId}/${task.model}${
          // The lead attributes insights to a seat's model, so it is told when another stood in.
          task.teamChat?.substituteFor === undefined
            ? ""
            : `, standing in for ${task.teamChat.substituteFor.model}, which reached its usage limit`
        }, ${task.status}; native child ${task.childThreadId}):\n${
          task.result === null
            ? "No contribution was returned."
            : task.result.length > 6000
              ? `${task.result.slice(0, 6000)}\n[Excerpt; open the native child thread for the complete result.]`
              : task.result
        }`,
    )
    .join("\n\n");

export const make = Effect.gen(function* () {
  const deliveryOption = yield* Effect.serviceOption(DeliveryService.DeliveryService);
  const limitedSeatsOption = yield* Effect.serviceOption(LimitedSeats.LimitedSeats);
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const { attachmentsDir } = yield* ServerConfig;

  /** The engine's seats a board task's system turn starts, when the turn is an engine stage. */
  const engineStageOf = Effect.fn("NativeTeamChat.engineStageOf")(function* (
    threadId: ThreadId,
    run: { readonly userMessageId: MessageId | null },
  ) {
    if (run.userMessageId === null || !isEngineStageMessageId(run.userMessageId)) return undefined;
    const messages = yield* projections.getMessagesById(threadId, [run.userMessageId]);
    const source = messages.get(run.userMessageId)?.notification?.source;
    return source?.kind === "engine_stage" ? source : undefined;
  });

  /**
   * An engine stage: each seat starts as a child of this turn, in the engine's worktree and with
   * its access, and the lead's turn waits until every one is terminal. Then the lead gets their
   * results, to keep track of the task; each answer is the engine's already.
   */
  const runEngineStage = Effect.fn("NativeTeamChat.engineStage")(function* (
    input: { readonly threadId: ThreadId; readonly runId: RunId },
    run: {
      readonly status: string;
      readonly rootNodeId: NodeId | null;
    },
    subagents: ReadonlyArray<OrchestrationV2Subagent>,
    stage: Extract<OrchestrationV2NotificationSource, { kind: "engine_stage" }>,
    delivery: DeliveryService.DeliveryService["Service"],
  ) {
    if (run.rootNodeId === null)
      return yield* new NativeTeamChatError({ runId: input.runId, reason: "state" });
    if (run.status !== "starting") return { ready: false, context: "" };
    const started: Array<OrchestrationV2Subagent> = [];
    let waiting = false;
    for (const seat of stage.seats) {
      const commandId = seatCommandId(input.threadId, seat.attemptId);
      const task = subagents.find((candidate) => candidate.childThreadId === seat.childThreadId);
      if (task !== undefined) {
        started.push(task);
        if (!terminal(task)) waiting = true;
        continue;
      }
      // The prompt stays with the engine, so the turn carries no copy of it.
      const attempt = yield* delivery
        .read({ path: nativeAttemptPath(seat.attemptId) })
        .pipe(Effect.flatMap((response) => decodeAttempt(response.body)));
      // A step the engine ended or asked to stop starts no child.
      if (isTerminalAttempt(attempt.state) || attempt.cancelRequested || !attempt.prompt?.trim())
        continue;
      yield* threads.dispatch({
        type: "delegated_task.request",
        commandId,
        createdBy: "system",
        creationSource: "server",
        parentThreadId: input.threadId,
        parentRunId: input.runId,
        parentNodeId: run.rootNodeId,
        // A seat of the turn's own round: the orchestrator resumes the turn held at its start
        // once the seat ends, as for a team's seats, and holds steers meanwhile.
        teamChat: { sourceRunId: input.runId, stage: "engine", seat: seat.seat },
        title: `${seat.seat} · ${stage.stage}`,
        task: attempt.prompt,
        modelSelection: seat.modelSelection,
        // A read-only seat runs in the mode that asks, and TeamChatReadOnlyReactor declines it.
        runtimeMode: seat.access === "full" ? "full-access" : "approval-required",
        interactionMode: "default",
        workspaceStrategy: { type: "existing_worktree", worktreePath: seat.worktreePath },
        completionWake: "settled_only",
      });
      // Its child waits in the engine's worktree until BoardTaskExecution prepares its run.
      waiting = true;
    }
    if (waiting) return { ready: false, context: "" };
    return {
      ready: true,
      context: `The engine ran the ${stage.stage} stage of this board task with ${
        started.length === 0 ? "no seat: none of them started" : "these seats"
      }. Each answer below is reported to the engine as that seat's result, which the engine judges. Keep track of where the task stands; do not redo their work.${
        started.length === 0 ? "" : `\n\n${contributions(started)}`
      }`,
    };
  });

  const prepareTurn: NativeTeamChat["Service"]["prepareTurn"] = Effect.fn(
    "NativeTeamChat.prepareTurn",
  )(
    function* (input) {
      if (Option.isNone(deliveryOption)) return { ready: true, context: "" };
      const delivery = deliveryOption.value;
      const state = yield* delivery.threadState(input.threadId);
      let binding = state.binding;
      const lineup = state.lineup;
      // An engine stage starts its seats whatever the team, so a board task's thread reads on.
      if (lineup === undefined && !isBoardTaskThreadId(input.threadId))
        return { ready: true, context: "" };
      const parent = yield* projections.getThreadRecords(input.threadId, [
        "runs",
        "subagents",
        "turnItems",
      ]);
      const run = parent.runs.find((candidate) => candidate.id === input.runId);
      // The engine does a board task's work, so a message there, a person's included, goes to the
      // lead alone: a team round would do that work a second time. Only the engine's brief starts
      // the team round, and an engine stage starts the engine's own seats.
      if (
        boardTaskOfMarker(parent.thread.lineage.engineIntake) !== null &&
        !isBoardBriefMessageId(run?.userMessageId)
      ) {
        const stage = run === undefined ? undefined : yield* engineStageOf(input.threadId, run);
        if (run === undefined || stage === undefined) return { ready: true, context: "" };
        return yield* runEngineStage(input, run, parent.subagents, stage, delivery);
      }
      if (lineup === undefined) return { ready: true, context: "" };
      const roster = lineup.participants;
      // Participants take a team's roles when there is one; with none they join as themselves.
      const team = binding?.team ?? lineup.team;
      const group = team === undefined ? "this conversation" : `team ${team}`;
      if (run === undefined || run.rootNodeId === null || run.activeAttemptId === null) {
        return yield* new NativeTeamChatError({ runId: input.runId, reason: "state" });
      }
      if (run.status !== "starting") return { ready: false, context: "" };
      const { rootNodeId, activeAttemptId } = run;
      const history = yield* projections.getThreadRecords(input.threadId, ["messages"], {
        messageRunIds: parent.runs
          .filter((candidate) => candidate.ordinal <= run.ordinal)
          .toSorted((left, right) => right.ordinal - left.ordinal)
          .slice(0, 6)
          .map((candidate) => candidate.id),
      });
      const message = history.messages.find((candidate) => candidate.id === run.userMessageId);
      if (message === undefined)
        return yield* new NativeTeamChatError({ runId: input.runId, reason: "state" });
      if (
        isCompactionCommandMessage(message) ||
        parseGoalCommand(message) !== null ||
        message.idleCompaction !== undefined ||
        message.notification !== undefined ||
        message.delegatedCompletion !== undefined
      ) {
        return { ready: true, context: "" };
      }
      // Participants get the files as paths to read, not as content in their context.
      const files = message.attachments.flatMap((attachment) => {
        const path = resolveAttachmentPath({ attachmentsDir, attachment });
        return path === null ? [] : [`- ${attachment.name}: ${path}`];
      });
      const attached =
        files.length === 0
          ? ""
          : `\n\nFiles attached to the latest message, to read from these paths:\n${files.join("\n")}`;
      const conversation = history.messages
        .map(
          (message) =>
            `${message.role}: ${projectComposerContextForProvider({ text: message.text, records: message.context?.records ?? [] })}`,
        )
        .join("\n\n")
        .slice(-24000);
      const tasks = parent.subagents.filter((task) => task.teamChat?.sourceRunId === input.runId);
      const initial = tasks.filter((task) => task.teamChat?.stage === "contribution");
      const critiques = tasks.filter((task) => task.teamChat?.stage === "critique");
      const skipId = (seat: string) =>
        ids.derive.runSignalTurnItem({ runId: input.runId, signal: `team-seat-skipped:${seat}` });
      const fallbackId = ids.derive.runSignalTurnItem({
        runId: input.runId,
        signal: "team-setup-fallback",
      });
      const skipped = new Map<string, string>();
      for (const seat of roster) {
        const notice = parent.turnItems.find((item) => item.id === skipId(seat.seat));
        if (notice?.type === "system_notice") skipped.set(seat.seat, notice.message);
      }
      // Notices preserve admission failures even when a provider or team changes on a later wake.
      let noticesWritten = 0;
      const recordSkip = Effect.fn("NativeTeamChat.recordSkip")(function* (
        seat: string,
        reason: string,
        noticeId = skipId(seat),
        // A substitute is a note on a seat that joins, not a seat that is left out.
        substitute = false,
      ) {
        const now = yield* DateTime.now;
        const written = yield* eventSink.writeIfRunCurrent({
          threadId: input.threadId,
          runId: input.runId,
          activeAttemptId,
          expectedStatus: "starting",
          events: [
            {
              type: "turn-item.updated",
              id: yield* ids.allocate.event({ threadId: input.threadId }),
              threadId: input.threadId,
              runId: input.runId,
              nodeId: rootNodeId,
              occurredAt: now,
              payload: {
                type: "system_notice",
                id: noticeId,
                threadId: input.threadId,
                runId: input.runId,
                nodeId: run.rootNodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal:
                  Math.max(0, ...parent.turnItems.map((item) => item.ordinal)) +
                  skipped.size +
                  (noticesWritten += 1),
                status: substitute ? "completed" : "failed",
                title: substitute ? `${seat} · substitute` : `${seat} · skipped`,
                message: reason,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
              },
            },
          ],
        });
        if (!written.committed)
          return yield* new NativeTeamChatError({ runId: input.runId, reason: "state" });
        if (!substitute) skipped.set(seat, reason);
      });
      const fallback = Effect.fn("NativeTeamChat.fallback")(function* (reason: string) {
        if (!tasks.every(terminal)) return { ready: false, context: "" };
        const notice = parent.turnItems.find((item) => item.id === fallbackId);
        if (notice?.type !== "system_notice")
          yield* recordSkip("Team discussion", reason, fallbackId);
        return {
          ready: true,
          context: teamDiscussionContext({
            group,
            members: [],
            discussionDidNotRun: true,
            discussionFailureReason: notice?.type === "system_notice" ? notice.message : reason,
            contributions: contributions(initial),
          }),
        };
      });
      const previousFallback = parent.turnItems.find((item) => item.id === fallbackId);
      if (previousFallback?.type === "system_notice")
        return yield* fallback(previousFallback.message);
      if (
        roster.length < 2 ||
        roster.length > 12 ||
        new Set(roster.map((seat) => seat.seat)).size !== roster.length
      )
        return yield* fallback("The team roster must contain between two and twelve unique seats.");
      const done = (round: ReadonlyArray<OrchestrationV2Subagent>) =>
        round.every(terminal) &&
        roster.every(
          (seat) =>
            skipped.has(seat.seat) || round.some((task) => task.teamChat?.seat === seat.seat),
        );
      // An engine stage's seats are the engine's steps, never an earlier round of this team.
      const followUp = parent.subagents.some(
        (task) =>
          task.teamChat !== undefined &&
          task.teamChat.stage !== "engine" &&
          task.teamChat.sourceRunId !== input.runId,
      );
      // Read-only by default: a participant asks before it changes anything, and
      // TeamChatReadOnlyReactor declines what it asks.
      const accessOf = (seat: (typeof roster)[number]) => {
        const access = deliveryParticipantAccess(lineup, seat.seat);
        // A read-only seat runs in the mode that asks, and every such request is declined.
        return access === "read-only"
          ? { readOnly: true, access: "approval-required" as const }
          : { readOnly: false, access };
      };
      const policy = deliveryLimitedSeatPolicy(lineup);
      type StandIn = {
        readonly selection: ModelSelection;
        readonly substituteFor?: NonNullable<
          NonNullable<OrchestrationV2Subagent["teamChat"]>["substituteFor"]
        >;
      };
      /** Seats this call starts on a substitute, by seat. */
      const standIns = new Map<string, StandIn>();
      const turnStandIn = (seat: string): ModelSelection | undefined => {
        const task = tasks.find(
          (candidate) =>
            candidate.teamChat?.seat === seat && candidate.teamChat.substituteFor !== undefined,
        );
        if (task === undefined) return undefined;
        return (
          task.modelSelection ??
          (task.model === null
            ? undefined
            : createModelSelection(task.providerInstanceId, task.model))
        );
      };
      const runsOn = (seat: (typeof roster)[number]) =>
        standIns.get(seat.seat)?.selection ?? turnStandIn(seat.seat) ?? seat.modelSelection;
      /**
       * What a seat starts on: its own model, or a substitute when that one is limited. Undefined
       * once the seat has been left out, with its notice written.
       */
      const standIn = Effect.fn("NativeTeamChat.standIn")(function* (
        seat: (typeof roster)[number],
        facts: LimitedSeatFacts,
      ) {
        const own = seatModelOf(seat.modelSelection);
        const limit = seatLimit(facts, own);
        if (limit === null) return { selection: seat.modelSelection } satisfies StandIn;
        const limited = `${seat.seat}: ${modelName(facts, own)} has reached its usage limit${limit.resetAt ? ` until ${formatLimitReset(limit.resetAt)}` : ""}.`;
        const substituteFor = { ...own, resetAt: limit.resetAt };
        const earlier = turnStandIn(seat.seat);
        if (earlier !== undefined) {
          // One swap a turn: the stand-in chosen for this turn is kept, or the seat sits out.
          if (seatLimit(facts, seatModelOf(earlier)) === null)
            return { selection: earlier, substituteFor } satisfies StandIn;
          yield* recordSkip(
            seat.seat,
            `${limited} Its substitute ${modelName(facts, seatModelOf(earlier))} is limited too, and a seat is swapped once a turn.`,
          );
          return undefined;
        }
        if (policy === "skip") {
          yield* recordSkip(seat.seat, `${limited} Left out of this message.`);
          return undefined;
        }
        const pool = limitedSeatPool({
          facts,
          roster,
          lead: parent.thread.modelSelection,
          seat,
          // A seat not started yet still holds the substitute a person agreed to for it.
          runsOn: (other) =>
            standIns.get(other.seat)?.selection ??
            turnStandIn(other.seat) ??
            agreedStandIn({ facts, policy, seat: other }) ??
            other.modelSelection,
        });
        const free = firstFreeFavorite(pool);
        const none = `${limited} No favorite model is free, so ${seat.seat} waits.`;
        if (policy === "ask" || seat.picked === true) {
          const agreed = seat.substitute;
          if (agreed !== undefined && isFreeCandidate(pool, seatModelOf(agreed)))
            return { selection: agreed, substituteFor } satisfies StandIn;
          yield* recordSkip(
            seat.seat,
            free === null
              ? none
              : `${limited} ${
                  policy === "ask"
                    ? ""
                    : "Its model was chosen by hand, so it is not swapped without asking. "
                }${modelName(facts, free)} is free: swap to it from the notice to use it from the next message.`,
          );
          return undefined;
        }
        if (free === null) {
          yield* recordSkip(seat.seat, none);
          return undefined;
        }
        return {
          selection: createModelSelection(free.instanceId, free.model),
          substituteFor,
        } satisfies StandIn;
      });
      const mode = lineup.critique ?? "first";
      const critiqueWanted = mode === "always" || (mode === "first" && !followUp);
      const stage = done(initial) ? "critique" : "contribution";
      const current = stage === "critique" ? critiques : initial;
      const commandFor = (seat: (typeof roster)[number]) =>
        CommandId.make(`team-chat:${input.threadId}:${input.runId}:${stage}:${seat.seat}`);
      const candidates = roster.filter(
        (seat) =>
          !skipped.has(seat.seat) && !current.some((task) => task.teamChat?.seat === seat.seat),
      );
      if (
        roster.length - skipped.size >= 2 &&
        !(done(initial) && (done(critiques) || !critiqueWanted))
      ) {
        const facts =
          Option.isSome(limitedSeatsOption) && !isServerOwnedThreadLineage(parent.thread.lineage)
            ? yield* limitedSeatsOption.value.facts(input.threadId)
            : undefined;
        const available = yield* Effect.forEach(
          candidates,
          Effect.fn("NativeTeamChat.preflight")(function* (seat) {
            const runsOn = facts === undefined ? undefined : yield* standIn(seat, facts);
            if (facts !== undefined && runsOn === undefined) return undefined;
            const selection = runsOn?.selection ?? seat.modelSelection;
            const instance = yield* instances.getInstance(selection.instanceId);
            const enabled = yield* threads.isProviderInstanceEnabledForProject({
              projectId: parent.thread.projectId,
              instanceId: selection.instanceId,
            });
            let reason: string | undefined;
            if (instance === undefined) reason = "provider is unavailable";
            else if (!instance.enabled) reason = "provider is disabled";
            else if (!enabled) reason = "provider is not enabled for this project";
            if (reason !== undefined || instance === undefined) {
              yield* recordSkip(seat.seat, `${seat.seat}: ${reason}.`);
              return undefined;
            }
            const snapshot = yield* instance.snapshot.getSnapshot;
            if (!snapshot.installed) {
              yield* recordSkip(seat.seat, `${seat.seat}: provider is not installed.`);
              return undefined;
            }
            const { readOnly, access } = accessOf(seat);
            const refused =
              runtimeModeProblem(snapshot.runtimeModes, access) ??
              (snapshot.supportedRuntimeModes?.includes(access) === false
                ? "This provider cannot run in this mode."
                : undefined);
            if (refused !== undefined) {
              yield* recordSkip(
                seat.seat,
                readOnly
                  ? `${seat.seat} cannot be held to read-only: ${refused}`
                  : `${seat.seat} cannot join with ${access} access: ${refused}`,
              );
              return undefined;
            }
            const adapter = yield* adapters.get(selection.instanceId).pipe(
              Effect.catchTags({
                ProviderAdapterRegistryLookupError: () => Effect.undefined,
              }),
            );
            if (adapter === undefined) {
              yield* recordSkip(seat.seat, `${seat.seat}: provider is unavailable.`);
              return undefined;
            }
            if (facts !== undefined && runsOn?.substituteFor !== undefined) {
              const { resetAt } = runsOn.substituteFor;
              yield* recordSkip(
                seat.seat,
                `${seat.seat} runs on ${modelName(facts, seatModelOf(selection))} this turn: ${modelName(facts, runsOn.substituteFor)} has reached its usage limit${resetAt ? ` until ${formatLimitReset(resetAt)}` : ""}.`,
                ids.derive.runSignalTurnItem({
                  runId: input.runId,
                  signal: `team-seat-substitute:${stage}:${seat.seat}`,
                }),
                true,
              );
              standIns.set(seat.seat, runsOn);
            }
            return adapter;
          }),
        );
        if (team !== undefined && roster.length - skipped.size >= 2) {
          const cwd =
            parent.thread.worktreePath ??
            binding?.workspace ??
            (yield* projects
              .get(parent.thread.projectId)
              .pipe(
                Effect.map(Option.map((project) => project.workspaceRoot)),
                Effect.map(Option.getOrUndefined),
              ));
          if (cwd === undefined)
            return yield* fallback("No working folder is available for the team.");
          const configurations = new Map<string, string>();
          for (const [index, seat] of candidates.entries()) {
            if (roster.length - skipped.size < 2) break;
            const adapter = available[index];
            if (adapter === undefined) continue;
            const member = yield* delivery
              .bindThread({
                threadId: ids.derive.delegatedTaskThread({ commandId: commandFor(seat) }),
                team,
                role: seat.role,
                driver: adapter.driver,
                cwd,
              })
              .pipe(
                Effect.catchTags({
                  DeliveryError: Effect.fn("NativeTeamChat.skipBindingFailure")(function* (error) {
                    if (error.status === 401 || error.status === 403) return yield* error;
                    yield* recordSkip(seat.seat, `${seat.seat}: ${error.message}`);
                    return undefined;
                  }),
                }),
              );
            if (member === undefined) continue;
            configurations.set(seat.seat, member.configuration);
          }
          const revisions = new Set(configurations.values());
          const revision = revisions.values().next().value;
          if (
            binding !== null &&
            tasks.length === 0 &&
            configurations.size >= 2 &&
            revisions.size === 1 &&
            revision !== undefined &&
            revision !== binding.configuration
          ) {
            binding = yield* delivery.refreshThread(input.threadId, revision);
          }
          for (const [seat, configuration] of configurations) {
            if (binding !== null && configuration !== binding.configuration) {
              yield* recordSkip(
                seat,
                `${seat}: the team setup changed while this discussion was being prepared. This turn uses ${binding.configuration}, but this participant uses ${configuration}. The next turn can adopt the updated setup in this conversation. Recorded contributions are preserved.`,
              );
            }
          }
        }
      }
      const eligible = roster.filter((seat) => !skipped.has(seat.seat));
      const insufficientSeats = eligible.length < 2;
      if (insufficientSeats && !tasks.every(terminal)) return { ready: false, context: "" };
      const discussionDidNotRun = insufficientSeats && initial.length === 0;
      if (insufficientSeats || (done(initial) && (done(critiques) || !critiqueWanted))) {
        return {
          ready: true,
          context: teamDiscussionContext({
            group,
            members: eligible.map((seat) => ({
              seat: seat.seat,
              role: seat.role,
              providerInstanceId: runsOn(seat).instanceId,
              model: runsOn(seat).model,
              access: deliveryParticipantAccess(lineup, seat.seat),
            })),
            skipped: roster.flatMap((seat) => {
              const reason = skipped.get(seat.seat);
              return reason === undefined
                ? []
                : [
                    {
                      seat: seat.seat,
                      role: seat.role,
                      reason,
                      contributed: initial.some((task) => task.teamChat?.seat === seat.seat),
                    },
                  ];
            }),
            discussionDidNotRun,
            discussionStopped: insufficientSeats && initial.length > 0,
            contributions: contributions(initial),
            ...(critiques.length > 0 ? { critiques: contributions(critiques) } : {}),
          }),
        };
      }
      // Admission can finish a round without dispatching a child to wake the lead.
      if (stage === "contribution" && done(initial)) return yield* prepareTurn(input);
      const missing = candidates.filter((seat) => !skipped.has(seat.seat));
      for (const seat of missing) {
        const commandId = commandFor(seat);
        const { readOnly, access } = accessOf(seat);
        yield* threads.dispatch({
          type: "delegated_task.request",
          commandId,
          createdBy: "system",
          creationSource: "server",
          parentThreadId: input.threadId,
          parentRunId: input.runId,
          parentNodeId: run.rootNodeId,
          teamChat: {
            sourceRunId: input.runId,
            stage,
            seat: seat.seat,
            ...(standIns.get(seat.seat)?.substituteFor === undefined
              ? {}
              : { substituteFor: standIns.get(seat.seat)!.substituteFor! }),
          },
          title: `${seat.seat} · ${stage}`,
          task: `Participate as ${seat.role}, seat ${seat.seat}, in ${group}. ${
            readOnly
              ? "You are read-only here: anything that would change a file, a branch, a pull request, a board or any other system is declined, even when the user's message asks for the work to be done. Say what should be done and why; the orchestrator acts."
              : "This is a discussion: change nothing here, even when the user's message asks for the work to be done. Do not edit files, commit, push, post or delegate. Say what should be done, by whom and why; the orchestrator decides who does what and hands out the work afterwards."
          } ${
            stage === "contribution"
              ? "Give your independent assessment of the latest user message, with evidence, assumptions, and objections."
              : "Critique the independent contributions below. Identify errors, disagreements, overlooked alternatives, and evidence that changes your conclusion. Do not merely repeat the other participants."
          }\n\nConversation:\n${conversation}${attached}${stage === "critique" ? `\n\nIndependent contributions:\n${contributions(initial)}` : ""}`,
          modelSelection: standIns.get(seat.seat)?.selection ?? seat.modelSelection,
          runtimeMode: access,
          // No seat gets plan mode: a harness in it writes a plan and asks for its approval,
          // which a read-only seat is refused, and then asks the person what to revise. A
          // read-only seat is held by its access and TeamChatReadOnlyReactor instead.
          interactionMode: "default",
          completionWake: "settled_only",
        });
      }
      return { ready: false, context: "" };
    },
    (effect, input) =>
      effect.pipe(
        Effect.tapError(() =>
          projections.getThreadRecords(input.threadId, ["subagents"]).pipe(
            Effect.flatMap(({ subagents }) =>
              Effect.forEach(
                subagents.filter(
                  (task) => task.teamChat?.sourceRunId === input.runId && !terminal(task),
                ),
                (task) =>
                  threads.dispatch({
                    type: "subagent.stop",
                    commandId: CommandId.make(`team-chat:${task.id}:admission-failed`),
                    threadId: input.threadId,
                    runId: input.runId,
                    subagentId: task.id,
                  }),
                { discard: true },
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.logError("Failed to stop a team discussion after admission failed", cause),
            ),
          ),
        ),
        Effect.mapError((cause) =>
          isNativeTeamChatError(cause)
            ? cause
            : new NativeTeamChatError({ runId: input.runId, reason: "dispatch", cause }),
        ),
      ),
  );
  return NativeTeamChat.of({ prepareTurn });
});

export const layer = Layer.effect(NativeTeamChat, make);
