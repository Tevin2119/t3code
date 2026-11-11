import {
  CommandId,
  isCompactionCommandMessage,
  parseGoalCommand,
  type OrchestrationV2Subagent,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DeliveryService from "./DeliveryService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

export class NativeTeamChatError extends Schema.TaggedError<NativeTeamChatError>()(
  "NativeTeamChatError",
  {
    runId: RunId,
    reason: Schema.Literals(["roster", "state", "dispatch", "attachments"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "attachments") {
      return "Team discussions currently support text only. Remove attachments or use an ordinary chat so participants are not asked to review files they cannot see.";
    }
    return this.reason === "roster"
      ? "Choose between two and twelve distinct team participants with available providers."
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

const isNativeTeamChatError = Schema.is(NativeTeamChatError);
const terminal = (task: OrchestrationV2Subagent) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(task.status);

const contributions = (tasks: ReadonlyArray<OrchestrationV2Subagent>) =>
  tasks
    .map(
      (task) =>
        `${task.teamChat?.seat ?? task.title} (${task.providerInstanceId}/${task.model}, ${task.status}; native child ${task.childThreadId}):\n${
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
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  return NativeTeamChat.of({
    prepareTurn: Effect.fn("NativeTeamChat.prepareTurn")(
      function* (input) {
        if (Option.isNone(deliveryOption)) return { ready: true, context: "" };
        const delivery = deliveryOption.value;
        const { binding } = yield* delivery.threadState(input.threadId);
        if (binding?.orchestration === undefined) return { ready: true, context: "" };
        const roster = binding.orchestration.participants;
        if (
          roster.length < 2 ||
          roster.length > 12 ||
          new Set(roster.map((seat) => seat.seat)).size !== roster.length ||
          new Set(
            roster.map((seat) =>
              JSON.stringify([seat.modelSelection.instanceId, seat.modelSelection.model]),
            ),
          ).size !== roster.length
        ) {
          return yield* new NativeTeamChatError({ runId: input.runId, reason: "roster" });
        }
        const parent = yield* projections.getThreadRecords(input.threadId, ["runs", "subagents"]);
        const run = parent.runs.find((candidate) => candidate.id === input.runId);
        if (run === undefined || run.rootNodeId === null) {
          return yield* new NativeTeamChatError({ runId: input.runId, reason: "state" });
        }
        if (run.status !== "starting") return { ready: false, context: "" };
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
        if (message.attachments.length > 0) {
          return yield* new NativeTeamChatError({ runId: input.runId, reason: "attachments" });
        }
        const conversation = history.messages
          .map((message) => `${message.role}: ${message.text}`)
          .join("\n\n")
          .slice(-24000);
        const tasks = parent.subagents.filter((task) => task.teamChat?.sourceRunId === input.runId);
        const initial = tasks.filter((task) => task.teamChat?.stage === "contribution");
        const critiques = tasks.filter((task) => task.teamChat?.stage === "critique");
        const initialDone = initial.length === roster.length && initial.every(terminal);
        const critiqueDone = critiques.length === roster.length && critiques.every(terminal);
        const followUp = parent.subagents.some(
          (task) => task.teamChat !== undefined && task.teamChat.sourceRunId !== input.runId,
        );
        const mode = binding.orchestration.critique ?? "first";
        const critiqueWanted = mode === "always" || (mode === "first" && !followUp);
        if (initialDone && (critiqueDone || !critiqueWanted)) {
          return {
            ready: true,
            context: `<team_discussion>\nYou are the orchestrator for team ${binding.team}. The native participants have completed independent contributions${critiqueWanted ? " and a critique round" : ""}. Synthesize their evidence and disagreements into a response to the latest user message. Attribute useful insights to their seat/model, acknowledge failed or missing contributions, and distinguish consensus from unresolved disagreement. Do not launch these rounds again.\n\nIndependent contributions:\n${contributions(initial)}${critiqueWanted ? `\n\nCritiques:\n${contributions(critiques)}` : ""}\n</team_discussion>`,
          };
        }
        const stage = initialDone ? "critique" : "contribution";
        const current = initialDone ? critiques : initial;
        const missing = roster.filter(
          (seat) => !current.some((task) => task.teamChat?.seat === seat.seat),
        );
        if (missing.length === 0) return { ready: false, context: "" };
        const available = yield* Effect.forEach(
          roster,
          Effect.fn("NativeTeamChat.preflight")(function* (seat) {
            const instance = yield* instances.getInstance(seat.modelSelection.instanceId);
            const enabled = yield* threads.isProviderInstanceEnabledForProject({
              projectId: parent.thread.projectId,
              instanceId: seat.modelSelection.instanceId,
            });
            if (instance === undefined || !instance.enabled || !enabled) {
              return yield* new NativeTeamChatError({ runId: input.runId, reason: "roster" });
            }
            const snapshot = yield* instance.snapshot.getSnapshot;
            if (
              !snapshot.installed ||
              snapshot.supportedRuntimeModes?.includes("approval-required") === false
            ) {
              return yield* new NativeTeamChatError({ runId: input.runId, reason: "roster" });
            }
            return yield* adapters.get(seat.modelSelection.instanceId);
          }),
        );
        const commandFor = (seat: (typeof roster)[number]) =>
          CommandId.make(`team-chat:${input.threadId}:${input.runId}:${stage}:${seat.seat}`);
        for (const seat of missing) {
          const commandId = commandFor(seat);
          const childThreadId = ids.derive.delegatedTaskThread({ commandId });
          const adapter = available[roster.indexOf(seat)]!;
          const member = yield* delivery.bindThread({
            threadId: childThreadId,
            team: binding.team,
            role: seat.role,
            driver: adapter.driver,
            cwd: parent.thread.worktreePath ?? binding.workspace,
          });
          if (member.configuration !== binding.configuration) {
            return yield* new NativeTeamChatError({ runId: input.runId, reason: "roster" });
          }
        }
        for (const seat of missing) {
          const commandId = commandFor(seat);
          yield* threads.dispatch({
            type: "delegated_task.request",
            commandId,
            createdBy: "system",
            creationSource: "server",
            parentThreadId: input.threadId,
            parentRunId: input.runId,
            parentNodeId: run.rootNodeId,
            teamChat: { sourceRunId: input.runId, stage, seat: seat.seat },
            title: `${seat.seat} · ${stage}`,
            task: `Participate as ${seat.role}, seat ${seat.seat}, in team ${binding.team}. This is a read-only discussion: do not edit files, commit, push, or delegate. ${
              stage === "contribution"
                ? "Give your independent assessment of the latest user message, with evidence, assumptions, and objections."
                : "Critique the independent contributions below. Identify errors, disagreements, overlooked alternatives, and evidence that changes your conclusion. Do not merely repeat the other participants."
            }\n\nConversation:\n${conversation}${stage === "critique" ? `\n\nIndependent contributions:\n${contributions(initial)}` : ""}`,
            modelSelection: seat.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "plan",
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
    ),
  });
});

export const layer = Layer.effect(NativeTeamChat, make);
