import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { EventId, NodeId, RunId, TurnItemId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SendFailureNotice from "./SendFailureNotice.ts";
import * as Fixture from "./SendFailureNotice.testkit.ts";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer);
const infra = Layer.mergeAll(EventSink.layer, IdAllocator.layer).pipe(Layer.provideMerge(stores));
const layer = SendFailureNotice.layer.pipe(
  Layer.provideMerge(infra),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(NodeCrypto.layerDigest),
);

it.layer(layer)("SendFailureNotice", (it) => {
  it.effect("writes one runless notice with the stored failure and never creates work", () =>
    Effect.gen(function* () {
      const fixture = yield* Fixture.seed("idempotent");
      const notice = yield* SendFailureNotice.SendFailureNotice;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      for (let retry = 0; retry < 6; retry++) {
        yield* notice.notify({ threadId: fixture.target.id, runId: fixture.run.id });
      }
      const sender = yield* projections.getThreadRecords(fixture.sender.id, [
        "turnItems",
        "runs",
        "messages",
        "providerTurns",
      ]);
      assert.lengthOf(sender.turnItems, 1);
      const item = sender.turnItems[0]!;
      assert.equal(
        item.id,
        (yield* IdAllocator.IdAllocatorV2).derive.runSignalTurnItem({
          runId: fixture.run.id,
          signal: "send-failed",
        }),
      );
      assert.equal(item.type, "system_notice");
      if (item.type !== "system_notice") return;
      assert.isNull(item.runId);
      assert.isNull(item.nodeId);
      assert.include(item.message, fixture.error.failure.message);
      assert.include(
        item.message,
        formatThreadLink(
          { environmentId: null, threadId: fixture.target.id },
          fixture.target.title,
        ),
      );
      assert.include(item.message, fixture.message.id);
      assert.include(item.message, "> Review the change");
      assert.notInclude(item.message, fixture.message.text);
      assert.deepEqual(sender.runs, []);
      assert.deepEqual(sender.messages, []);
      assert.deepEqual(sender.providerTurns, []);
      assert.deepEqual(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, []);
    }),
  );

  it.effect("appends the notice after sender history and preserves its position on replay", () =>
    Effect.gen(function* () {
      const f = yield* Fixture.seed("ordered");
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const notice = yield* SendFailureNotice.SendFailureNotice;
      const senderRun = {
        ...f.run,
        id: RunId.make("ordered:sender-run"),
        threadId: f.sender.id,
        status: "completed" as const,
        startedAt: f.now,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("ordered:sender-run-event"),
            type: "run.updated",
            threadId: f.sender.id,
            occurredAt: f.now,
            payload: senderRun,
          },
          {
            id: EventId.make("ordered:sender-history-event"),
            type: "turn-item.updated",
            threadId: f.sender.id,
            occurredAt: f.now,
            payload: {
              ...f.error,
              id: TurnItemId.make("ordered:sender-history"),
              threadId: f.sender.id,
              runId: senderRun.id,
            },
          },
        ],
      });
      yield* notice.notify({ threadId: f.target.id, runId: f.run.id });
      const sender = yield* projections.getThreadRecords(f.sender.id, ["turnItems"]);
      assert.lengthOf(sender.turnItems, 2);
      const history = sender.turnItems.find((item) => item.runId === senderRun.id)!;
      const item = sender.turnItems.find((item) => item.type === "system_notice")!;
      assert.isAbove(item.ordinal, history.ordinal);
      assert.equal(sender.turnItems.at(-1)!.id, item.id);
      assert.isNull(item.runId);
      assert.isNull(item.nodeId);
      yield* notice.notify({ threadId: f.target.id, runId: f.run.id });
      assert.deepEqual(
        (yield* projections.getThreadRecords(f.sender.id, ["turnItems"])).turnItems,
        sender.turnItems,
      );
      yield* sink.write({
        events: [
          {
            id: EventId.make("ordered:later-run-event"),
            type: "run.updated",
            threadId: f.sender.id,
            occurredAt: f.now,
            payload: { ...senderRun, id: RunId.make("ordered:later-run"), ordinal: 2 },
          },
        ],
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("ordered:replayed-notice-event"),
            type: "turn-item.updated",
            threadId: f.sender.id,
            occurredAt: f.now,
            payload: item,
          },
        ],
      });
      assert.deepEqual(
        (yield* projections.getThreadRecords(f.sender.id, ["turnItems"])).turnItems,
        sender.turnItems,
      );
    }),
  );

  it.effect.each([
    "message-gone",
    "no-sender",
    "self",
    "delegated",
    "child",
    "completed",
    "started",
    "no-error",
    "deleted-sender",
    "missing-sender",
    "archived-sender",
  ] as const)("rechecks stored eligibility: %s", (kind) =>
    Effect.gen(function* () {
      const f = yield* Fixture.seed(kind);
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      if (kind === "message-gone" || kind === "no-error" || kind === "missing-sender") {
        if (kind === "message-gone")
          yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id = ${f.target.id}`;
        if (kind === "no-error")
          yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${f.target.id}`;
        if (kind === "missing-sender")
          yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${f.sender.id}`;
      } else if (kind === "no-sender" || kind === "self") {
        const { senderThreadId: _, ...message } = f.message;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`guard-message:${f.target.id}`),
              type: "message.updated",
              threadId: f.target.id,
              occurredAt: f.now,
              payload: { ...message, ...(kind === "self" ? { senderThreadId: f.target.id } : {}) },
            },
          ],
        });
      } else if (kind === "delegated" || kind === "completed" || kind === "started") {
        yield* sink.write({
          events: [
            {
              id: EventId.make(`guard-run:${f.target.id}`),
              type: "run.updated",
              threadId: f.target.id,
              occurredAt: f.now,
              payload: {
                ...f.run,
                ...(kind === "delegated" ? { delegatedTaskId: NodeId.make("late-task") } : {}),
                ...(kind === "completed" ? { status: "completed" } : {}),
                ...(kind === "started" ? { startedAt: f.now } : {}),
              },
            },
          ],
        });
      } else {
        const thread =
          kind === "child"
            ? {
                ...f.target,
                lineage: {
                  ...f.target.lineage,
                  parentThreadId: f.sender.id,
                  relationshipToParent: "subagent" as const,
                },
              }
            : {
                ...f.sender,
                ...(kind === "deleted-sender" ? { deletedAt: f.now } : { archivedAt: f.now }),
              };
        yield* sink.write({
          events: [
            {
              id: EventId.make(`guard-thread:${f.target.id}`),
              type: "thread.metadata-updated",
              threadId: thread.id,
              occurredAt: f.now,
              payload: thread,
            },
          ],
        });
      }
      yield* (yield* SendFailureNotice.SendFailureNotice).notify({
        threadId: f.target.id,
        runId: f.run.id,
      });
      const rows = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM orchestration_v2_projection_turn_items WHERE thread_id = ${f.sender.id}`;
      assert.equal(rows[0]!.count, kind === "archived-sender" ? 1 : 0);
    }),
  );
});
