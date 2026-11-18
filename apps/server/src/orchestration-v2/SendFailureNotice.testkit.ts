import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EventSink from "./EventSink.ts";

export const seed = Effect.fn("SendFailureNoticeTestkit.seed")(function* (prefix = "notice") {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const senderId = ThreadId.make(`${prefix}:notice-sender`);
  const targetId = ThreadId.make(`${prefix}:notice-target`);
  const instanceId = ProviderInstanceId.make("codex");
  const thread = (id: ThreadId): OrchestrationV2AppThread => ({
    id,
    projectId: ProjectId.make("notice-project"),
    title: `Title ${id}`,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  });
  const run: OrchestrationV2Run = {
    id: RunId.make(`${prefix}:notice-run`),
    threadId: targetId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "test" },
    providerThreadId: null,
    userMessageId: MessageId.make(`${prefix}:notice-message`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "failed",
    queuePosition: null,
    requestedAt: now,
    startedAt: null,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
  };
  const message: OrchestrationV2ConversationMessage = {
    id: run.userMessageId,
    threadId: targetId,
    runId: run.id,
    nodeId: null,
    role: "user",
    text: `Review the change\n${"x".repeat(1200)}`,
    attachments: [],
    streaming: false,
    senderThreadId: senderId,
    createdBy: "agent",
    creationSource: "mcp",
    createdAt: now,
    updatedAt: now,
  };
  const error: OrchestrationV2TurnItem = {
    id: TurnItemId.make(`${prefix}:notice-error`),
    threadId: targetId,
    runId: run.id,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "failed",
    title: "Turn failed to start",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "error",
    failure: {
      message: "The provider could not start.",
      class: "provider_error",
      code: null,
      retryable: null,
    },
  };
  const target = thread(targetId);
  const sender = thread(senderId);
  yield* sink.write({
    events: [
      ...[target, sender].map((payload) => ({
        id: EventId.make(`created:${payload.id}`),
        type: "thread.created" as const,
        threadId: payload.id,
        occurredAt: now,
        payload,
      })),
      {
        id: EventId.make(`${prefix}:notice-run-event`),
        type: "run.updated",
        threadId: targetId,
        occurredAt: now,
        payload: run,
      },
      {
        id: EventId.make(`${prefix}:notice-message-event`),
        type: "message.updated",
        threadId: targetId,
        occurredAt: now,
        payload: message,
      },
      {
        id: EventId.make(`${prefix}:notice-error-event`),
        type: "turn-item.updated",
        threadId: targetId,
        occurredAt: now,
        payload: error,
      },
    ],
  });
  return { target, sender, run, message, error, now };
});
