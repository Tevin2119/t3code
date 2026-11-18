import { RunId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class SendFailureNotice extends Context.Service<
  SendFailureNotice,
  {
    readonly notify: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<
      void,
      | ProjectionStore.ProjectionStoreV2Error
      | EventSink.EventSinkV2Error
      | IdAllocator.IdAllocatorV2AllocationError
    >;
  }
>()("t3/orchestration-v2/SendFailureNotice") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  return SendFailureNotice.of({
    notify: Effect.fn("SendFailureNotice.notify")(function* ({ threadId, runId }) {
      const target = yield* projections.getThreadRecords(threadId, [
        "runs",
        "messages",
        "turnItems",
      ]);
      const run = target.runs.find((run) => run.id === runId);
      if (
        run === undefined ||
        run.status !== "failed" ||
        run.startedAt !== null ||
        run.delegatedTaskId !== undefined
      )
        return;
      const message = target.messages.find((message) => message.id === run.userMessageId);
      const senderThreadId = message?.senderThreadId;
      if (
        message === undefined ||
        senderThreadId === undefined ||
        senderThreadId === threadId ||
        (target.thread.lineage.relationshipToParent === "subagent" &&
          target.thread.lineage.parentThreadId === senderThreadId)
      )
        return;
      const error = target.turnItems.find((item) => item.runId === runId && item.type === "error");
      if (error?.type !== "error") return;
      const sender = yield* projections
        .getThreadRecords(senderThreadId, ["turnItems"])
        .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.undefined }));
      if (sender === undefined || sender.thread.deletedAt !== null) return;
      const id = ids.derive.runSignalTurnItem({ runId, signal: "send-failed" });
      if (sender.turnItems.some((item) => item.id === id)) return;
      const now = yield* DateTime.now;
      const environmentId = Option.isSome(environment)
        ? yield* environment.value.getEnvironmentId
        : null;
      const link = formatThreadLink({ environmentId, threadId }, target.thread.title);
      const quote = message.text.length > 1000 ? `${message.text.slice(0, 1000)}…` : message.text;
      yield* sink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId: senderThreadId }),
            type: "turn-item.updated",
            threadId: senderThreadId,
            occurredAt: now,
            payload: {
              id,
              threadId: senderThreadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "completed",
              title: "Sent message could not start",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "system_notice",
              message: `The turn in ${link} (${threadId}) could not start.\n\nMessage ${message.id}:\n${quote
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n")}\n\n${error.failure.message}`,
            },
          },
        ],
      });
    }),
  });
});

export const layer = Layer.effect(SendFailureNotice, make);
