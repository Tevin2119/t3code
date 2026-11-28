// The side chats of board task threads, recorded on their task in the engine (slice L2t) so the
// board and other environments list them. A side chat that is open here is the task's related
// thread, role "side"; once archived or deleted its link is removed, and restoring it puts the
// link back. Removing a link never changes the task, and nothing here touches a thread.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous digest: a link's key is compared while a pass reads its cards.
import * as NodeCrypto from "node:crypto";

import { type EnvironmentId, type OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { MOVED } from "./boardTaskWork.ts";
import { listBoardThreadRows } from "./boardThreadRows.ts";
import type { BoardTask } from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";

/** One of a task's related threads, as its lanes card and detail serve them. */
export const RelatedThreadLink = Schema.Struct({
  key: Schema.String,
  environmentId: Schema.String,
  threadId: Schema.String,
  role: Schema.String,
  setBy: Schema.String,
});
export type RelatedThreadLink = typeof RelatedThreadLink.Type;

/** A side chat of a board task's thread on this server, and whether it is open. */
export interface BoardSideChat {
  readonly threadId: ThreadId;
  readonly task: BoardTask;
  readonly open: boolean;
}

/**
 * The key a side chat is related under: the same for every write of one conversation, so a retry,
 * a second server pass and a restart all name one link.
 */
export const sideChatKey = (environmentId: string, threadId: string) =>
  `side-${NodeCrypto.createHash("sha256").update(`${environmentId}/${threadId}`).digest("hex").slice(0, 40)}`;

/**
 * The side chats whose parent is a board task thread here, archived and deleted ones included.
 * Each parent's task comes from the board's own rows, the reader of a task thread's marker.
 */
const listSideChats = Effect.fn("BoardTaskSideChats.list")(function* (threadId?: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const only = threadId === undefined ? sql`` : sql`AND thread_id = ${threadId}`;
  const rows = yield* sql<{
    id: string;
    parentId: string;
    archivedAt: string | null;
    deletedAt: string | null;
  }>`
    SELECT thread_id AS id, archived_at AS "archivedAt", deleted_at AS "deletedAt",
      json_extract(payload_json, '$.lineage.parentThreadId') AS "parentId"
    FROM orchestration_v2_projection_threads
    WHERE json_extract(payload_json, '$.lineage.sideChat') = 1
      AND json_extract(payload_json, '$.lineage.parentThreadId') IS NOT NULL
      ${only}
  `.pipe(NodeSqliteClient.readOnly);
  if (rows.length === 0) return [];
  const taskThreads = [
    ...(yield* listBoardThreadRows({ archived: false })),
    ...(yield* listBoardThreadRows({ archived: true })),
  ];
  const taskOf = new Map(taskThreads.map((row) => [row.threadId as string, row.task]));
  return rows.flatMap((row): ReadonlyArray<BoardSideChat> => {
    const task = taskOf.get(row.parentId);
    return task === undefined
      ? []
      : [
          {
            threadId: ThreadId.make(row.id),
            task,
            open: row.archivedAt === null && row.deletedAt === null,
          },
        ];
  });
});

const LIFECYCLE = new Set<OrchestrationV2DomainEvent["type"]>([
  "thread.created",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
]);

export class BoardTaskSideChats extends Context.Service<
  BoardTaskSideChats,
  {
    /** Records one side chat on its task as it stands now: linked while open, unlinked once closed. */
    readonly record: (threadId: ThreadId) => Effect.Effect<void>;
    /**
     * The board pass's retry: every side chat here whose task's card disagrees with it is
     * recorded again. Cards absent, or served without related threads, are left alone.
     */
    readonly sync: (input: {
      readonly cards: ReadonlyMap<
        string,
        {
          readonly state: string;
          readonly relatedThreads?: ReadonlyArray<RelatedThreadLink> | null | undefined;
        }
      >;
      readonly environmentId: EnvironmentId;
      readonly key: string;
    }) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/delivery/BoardTaskSideChats") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const delivery = yield* DeliveryService.DeliveryService;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const settings = yield* ServerSettings.ServerSettingsService;
  const engine = yield* Orchestrator.OrchestratorV2;

  const sideChats = (threadId?: ThreadId) =>
    listSideChats(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  /** One keyed write: PUT is a no-op on the engine for the value it holds, DELETE answers 204 for none. */
  const write = Effect.fn("BoardTaskSideChats.write")(function* (input: {
    readonly taskId: string;
    readonly threadId: string;
    readonly open: boolean;
    readonly environmentId: EnvironmentId;
    readonly key: string;
  }) {
    const { taskId, threadId, open, environmentId, key } = input;
    const written = yield* delivery
      .boardThreadAct({
        method: open ? "PUT" : "DELETE",
        path: `/api/tasks/${taskId}/threads/${sideChatKey(environmentId, threadId)}`,
        body: open
          ? { environmentId, threadId, role: "side", setBy: environmentId, key }
          : { setBy: environmentId, key },
      })
      .pipe(Effect.result);
    // A refusal or an engine away leaves the link for the board's next pass.
    if (written._tag === "Failure")
      yield* Effect.logDebug("A side chat was not recorded on its task.", {
        task: taskId,
        thread: threadId,
        status: written.failure.status ?? null,
      });
  });

  const enabledKey = Effect.gen(function* () {
    const config = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (config === null || !config.delivery.enabled) return undefined;
    return yield* delivery.boardApprovalKey;
  });

  const record: BoardTaskSideChats["Service"]["record"] = Effect.fn("BoardTaskSideChats.record")(
    function* (threadId) {
      const [chat] = yield* sideChats(threadId);
      if (chat === undefined) return;
      const key = yield* enabledKey;
      if (key === undefined) return;
      const environmentId = yield* identity.getEnvironmentId;
      yield* write({ taskId: chat.task.id, threadId, open: chat.open, environmentId, key });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("A side chat could not be recorded on its task.", { cause }),
    ),
  );

  const sync: BoardTaskSideChats["Service"]["sync"] = Effect.fn("BoardTaskSideChats.sync")(
    function* ({ cards, environmentId, key }) {
      const ours = (link: RelatedThreadLink) =>
        link.role === "side" && link.environmentId === environmentId;
      const chats = yield* sideChats();
      const seen = new Set<string>();
      for (const chat of chats) {
        seen.add(`${chat.task.id}/${chat.threadId}`);
        const card = cards.get(chat.task.id);
        // An engine before L2 serves no related threads, and a moved task is recorded there.
        if (card?.relatedThreads == null || MOVED.has(card.state)) continue;
        const same = card.relatedThreads.filter(
          (link) => link.environmentId === environmentId && link.threadId === chat.threadId,
        );
        // Open: related under any key will do. Closed: only the link this server wrote is its to remove.
        const settled = chat.open
          ? same.length > 0
          : !same.some((link) => link.key === sideChatKey(environmentId, chat.threadId));
        if (settled) continue;
        yield* write({
          taskId: chat.task.id,
          threadId: chat.threadId,
          open: chat.open,
          environmentId,
          key,
        });
      }
      // A side chat this server linked and no longer has at all: its link goes too.
      for (const [taskId, card] of cards) {
        if (card.relatedThreads == null || MOVED.has(card.state)) continue;
        for (const link of card.relatedThreads) {
          if (!ours(link) || link.setBy !== environmentId) continue;
          if (link.key !== sideChatKey(environmentId, link.threadId)) continue;
          if (seen.has(`${taskId}/${link.threadId}`)) continue;
          yield* write({ taskId, threadId: link.threadId, open: false, environmentId, key });
        }
      }
    },
    Effect.catchCause((cause) =>
      Effect.logDebug("Side chats were not synced with their tasks.", { cause }),
    ),
  );

  // A side chat is recorded as it opens, closes or is restored; the board's pass retries.
  const start: BoardTaskSideChats["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        !LIFECYCLE.has(event.type) ||
        (event.type === "thread.created" && event.payload.lineage.sideChat !== true)
          ? Effect.void
          : record(event.threadId),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("The side chat event stream failed.", { cause }),
        ),
      ),
    );

  return BoardTaskSideChats.of({ record, sync, start });
});

export const layer = Layer.effect(BoardTaskSideChats, make);
