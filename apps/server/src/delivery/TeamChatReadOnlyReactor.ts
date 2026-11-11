import { CommandId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as DeliveryService from "./DeliveryService.ts";

export const READ_ONLY_FEEDBACK =
  "You take part in this team discussion read-only: nothing here may be changed, run to change something, committed, pushed, merged or posted. Say what should be done and why. The orchestrator acts.";

/**
 * Holds discussion participants to read-only. A participant runs in the mode that asks before
 * anything is changed, and this declines every such request, so nothing is changed and nobody
 * is asked. Only a conversation whose participants' access is left at its default is covered.
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
      if (parentThreadId === null) return;
      const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents"]);
      const participant = parent.subagents.some(
        (task) => task.childThreadId === child.id && task.teamChat !== undefined,
      );
      if (!participant) return;
      const { lineup } = yield* delivery.threadState(parentThreadId);
      if (lineup === undefined || lineup.access !== undefined) return;
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
