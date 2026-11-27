import {
  CommandId,
  deliveryParticipantAccess,
  type OrchestrationV2DomainEvent,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import { isBoardBriefMessageId } from "./boardTaskAttempts.ts";
import { boardTaskOfMarker } from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";

export const READ_ONLY_FEEDBACK =
  "You take part in this team discussion read-only: nothing here may be changed, run to change something, committed, pushed, merged or posted. Say what should be done and why. The orchestrator acts.";

/**
 * Holds discussion participants to read-only. A participant runs in the mode that asks before
 * anything is changed, and this declines every such request, so nothing is changed and nobody
 * is asked. Only a participant whose access in the conversation is read-only is covered.
 */
export class TeamChatReadOnlyReactor extends Context.Service<
  TeamChatReadOnlyReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/delivery/TeamChatReadOnlyReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const delivery = yield* DeliveryService.DeliveryService;

  /** Whether a child is a read-only seat of an engine stage, as its parent's system turn says. */
  const engineReadOnlySeat = Effect.fnUntraced(function* (
    parentThreadId: ThreadId,
    runId: RunId | null,
    childThreadId: ThreadId,
  ) {
    if (runId === null) return false;
    const records = yield* projections.getThreadRecords(parentThreadId, ["runs"], {
      runIds: [runId],
    });
    const messageId = records.runs.find((run) => run.id === runId)?.userMessageId ?? null;
    if (messageId === null) return false;
    const messages = yield* projections.getMessagesById(parentThreadId, [messageId]);
    const source = messages.get(messageId)?.notification?.source;
    return (
      source?.kind === "engine_stage" &&
      source.seats.some(
        (seat) => seat.childThreadId === childThreadId && seat.access === "read-only",
      )
    );
  });

  /**
   * Whether a board task thread's request comes from the engine's brief, in a thread that runs in
   * the mode that asks. Board task threads run in full access but for a read-only brief.
   */
  const readOnlyBrief = Effect.fnUntraced(function* (
    threadId: ThreadId,
    marker: string | null | undefined,
    runId: RunId | null | undefined,
  ) {
    if (boardTaskOfMarker(marker) === null || runId == null) return false;
    const records = yield* projections.getThreadRecords(threadId, ["runs"], { runIds: [runId] });
    const run = records.runs.find((candidate) => candidate.id === runId);
    return (
      records.thread.runtimeMode === "approval-required" &&
      isBoardBriefMessageId(run?.userMessageId)
    );
  });

  // Runs for every domain event; most events return before any work is needed.
  const handle: TeamChatReadOnlyReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (
        event.type !== "runtime-request.updated" ||
        event.payload.status !== "pending" ||
        event.payload.responseCapability.type !== "live" ||
        // Questions and tool calls are not requests to change something.
        event.payload.kind === "user_input" ||
        event.payload.kind === "dynamic_tool_call" ||
        event.payload.kind === "auth_refresh"
      ) {
        return;
      }
      const child = yield* projections.getThread(event.threadId);
      const parentThreadId = child.lineage.parentThreadId;
      if (parentThreadId === null) {
        // A board task's brief runs read-only in the mode that asks: every change is declined.
        if (!(yield* readOnlyBrief(child.id, child.lineage.engineIntake, event.runId))) return;
      } else {
        const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents"]);
        const task = parent.subagents.find((candidate) => candidate.childThreadId === child.id);
        if (task === undefined) return;
        const seat = task.teamChat?.seat;
        // An engine stage's seat holds the access its stage turn gave it, not the team's.
        if (task.teamChat?.stage === "engine") {
          if (!(yield* engineReadOnlySeat(parentThreadId, task.runId, child.id))) return;
        } else if (seat !== undefined) {
          const { lineup } = yield* delivery.threadState(parentThreadId);
          if (lineup === undefined || deliveryParticipantAccess(lineup, seat) !== "read-only")
            return;
        } else if (!(yield* engineReadOnlySeat(parentThreadId, task.runId, child.id))) return;
      }
      yield* engine.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`server:team-chat-read-only:${child.id}:${event.payload.id}`),
        threadId: child.id,
        requestId: event.payload.id,
        // Reading is what a participant is there for; nobody needs asking.
        ...(event.payload.kind === "file-read"
          ? { decision: "accept" as const }
          : {
              decision: "decline" as const,
              // A decline with a reason is refused for a provider that cannot take one.
              ...(event.payload.responseCapability.supportsFeedback
                ? { feedback: READ_ONLY_FEEDBACK }
                : {}),
            }),
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("declining a read-only participant's request failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: TeamChatReadOnlyReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("read-only participant event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies TeamChatReadOnlyReactor["Service"];
});

export const layer = Layer.effect(TeamChatReadOnlyReactor, make);
