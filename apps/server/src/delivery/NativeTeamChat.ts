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
import { runtimeModeProblem } from "@t3tools/provider-core/server/runtimeModeSupport";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as DeliveryService from "./DeliveryService.ts";
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
  const projects = yield* ProjectStore.ProjectStoreV2;
  const { attachmentsDir } = yield* ServerConfig;

  return NativeTeamChat.of({
    prepareTurn: Effect.fn("NativeTeamChat.prepareTurn")(
      function* (input) {
        if (Option.isNone(deliveryOption)) return { ready: true, context: "" };
        const delivery = deliveryOption.value;
        const { binding, lineup } = yield* delivery.threadState(input.threadId);
        if (lineup === undefined) return { ready: true, context: "" };
        const roster = lineup.participants;
        // Participants take a team's roles when there is one; with none they join as themselves.
        const team = binding?.team ?? lineup.team;
        const group = team === undefined ? "this conversation" : `team ${team}`;
        if (
          roster.length < 2 ||
          roster.length > 12 ||
          new Set(roster.map((seat) => seat.seat)).size !== roster.length
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
          .map((message) => `${message.role}: ${message.text}`)
          .join("\n\n")
          .slice(-24000);
        const tasks = parent.subagents.filter((task) => task.teamChat?.sourceRunId === input.runId);
        const initial = tasks.filter((task) => task.teamChat?.stage === "contribution");
        const critiques = tasks.filter((task) => task.teamChat?.stage === "critique");
        // By seat, so a lineup changed while a round runs neither hangs it nor repeats it.
        const done = (round: ReadonlyArray<OrchestrationV2Subagent>) =>
          round.every(terminal) &&
          roster.every((seat) => round.some((task) => task.teamChat?.seat === seat.seat));
        const initialDone = done(initial);
        const critiqueDone = done(critiques);
        const followUp = parent.subagents.some(
          (task) => task.teamChat !== undefined && task.teamChat.sourceRunId !== input.runId,
        );
        // Read-only by default: a participant asks before it changes anything, and
        // TeamChatReadOnlyReactor declines what it asks.
        const readOnly = lineup.access === undefined;
        const access = lineup.access ?? "approval-required";
        const mode = lineup.critique ?? "first";
        const critiqueWanted = mode === "always" || (mode === "first" && !followUp);
        if (initialDone && (critiqueDone || !critiqueWanted)) {
          return {
            ready: true,
            context: `<team_discussion>\nYou are the orchestrator for ${group}. The native participants have completed independent contributions${critiqueWanted ? " and a critique round" : ""}. Synthesize their evidence and disagreements into a response to the latest user message. Attribute useful insights to their seat/model, acknowledge failed or missing contributions, and distinguish consensus from unresolved disagreement. Do not launch these rounds again.${readOnly ? " The participants are read-only and have changed nothing. When the user asks for work to be done, do it yourself in this thread under the project's own rules, or say plainly what should be handed to a team that builds." : ""}\n\nIndependent contributions:\n${contributions(initial)}${critiqueWanted ? `\n\nCritiques:\n${contributions(critiques)}` : ""}\n</team_discussion>`,
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
            if (!snapshot.installed) {
              return yield* new NativeTeamChatError({ runId: input.runId, reason: "roster" });
            }
            // A provider is never run in another mode than the one asked for, so say which seat.
            const refused =
              runtimeModeProblem(snapshot.runtimeModes, access) ??
              (snapshot.supportedRuntimeModes?.includes(access) === false
                ? "This provider cannot run in this mode."
                : undefined);
            if (refused !== undefined) {
              return yield* new NativeTeamChatError({
                runId: input.runId,
                reason: "roster",
                detail: readOnly
                  ? `${seat.seat} cannot be held to read-only: ${refused} Leave ${seat.seat} out, or give this conversation's participants full access.`
                  : `${seat.seat} cannot join with ${access} access: ${refused} Change the participants' access for this conversation, or leave ${seat.seat} out.`,
              });
            }
            return yield* adapters.get(seat.modelSelection.instanceId);
          }),
        );
        const commandFor = (seat: (typeof roster)[number]) =>
          CommandId.make(`team-chat:${input.threadId}:${input.runId}:${stage}:${seat.seat}`);
        if (team !== undefined) {
          const cwd =
            parent.thread.worktreePath ??
            binding?.workspace ??
            (yield* projects
              .get(parent.thread.projectId)
              .pipe(
                Effect.map(Option.map((project) => project.workspaceRoot)),
                Effect.map(Option.getOrUndefined),
              ));
          if (cwd === undefined) {
            return yield* new NativeTeamChatError({ runId: input.runId, reason: "state" });
          }
          for (const seat of missing) {
            const member = yield* delivery.bindThread({
              threadId: ids.derive.delegatedTaskThread({ commandId: commandFor(seat) }),
              team,
              role: seat.role,
              driver: available[roster.indexOf(seat)]!.driver,
              cwd,
            });
            if (binding !== null && member.configuration !== binding.configuration) {
              return yield* new NativeTeamChatError({ runId: input.runId, reason: "roster" });
            }
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
            task: `Participate as ${seat.role}, seat ${seat.seat}, in ${group}. ${
              readOnly
                ? "You are read-only here: anything that would change a file, a branch, a pull request, a board or any other system is declined, even when the user's message asks for the work to be done. Say what should be done and why; the orchestrator acts."
                : "This is a discussion: do not edit files, commit, push, or delegate unless the user's message asks you to."
            } ${
              stage === "contribution"
                ? "Give your independent assessment of the latest user message, with evidence, assumptions, and objections."
                : "Critique the independent contributions below. Identify errors, disagreements, overlooked alternatives, and evidence that changes your conclusion. Do not merely repeat the other participants."
            }\n\nConversation:\n${conversation}${attached}${stage === "critique" ? `\n\nIndependent contributions:\n${contributions(initial)}` : ""}`,
            modelSelection: seat.modelSelection,
            runtimeMode: access,
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
