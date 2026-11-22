import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import { BOARD_TASK_MARKER_LIKE, boardTaskOfMarker, type BoardTask } from "./boardThreadMarker.ts";

/** A thread this server made for a board task, with the task its marker names. */
export interface BoardThreadRow {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly task: BoardTask;
  /** The thread's pull request and issue links, as stored: JSON arrays, or null for none. */
  readonly pullRequests: string | null;
  readonly issues: string | null;
}

/**
 * The board task threads of this server, which no list shows. Thread to task only: the rows are
 * found by their marker and each names its task, and nothing here finds a thread from a task.
 */
export class BoardThreadRows extends Context.Service<
  BoardThreadRows,
  {
    readonly list: (options: {
      readonly archived: boolean;
    }) => Effect.Effect<ReadonlyArray<BoardThreadRow>, SqlError.SqlError>;
  }
>()("t3/delivery/boardThreadRows") {}

/** The rows, read with whatever database connection the caller holds. */
export const listBoardThreadRows = Effect.fn("listBoardThreadRows")(function* (options: {
  readonly archived: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    id: string;
    projectId: string;
    title: string;
    archivedAt: string | null;
    marker: string | null;
    pullRequests: string | null;
    issues: string | null;
  }>`
    SELECT t.thread_id AS id, t.project_id AS "projectId", t.title,
      t.archived_at AS "archivedAt",
      json_extract(t.payload_json, '$.pullRequests') AS "pullRequests",
      json_extract(t.payload_json, '$.issues') AS issues,
      json_extract(t.payload_json, '$.lineage.engineIntake') AS marker
    FROM orchestration_v2_projection_threads AS t
    WHERE t.deleted_at IS NULL
      AND json_extract(t.payload_json, '$.lineage.engineIntake') LIKE ${BOARD_TASK_MARKER_LIKE}
    ORDER BY t.updated_at DESC, id ASC
  `.pipe(NodeSqliteClient.readOnly);
  return rows.flatMap((row): ReadonlyArray<BoardThreadRow> => {
    const task = boardTaskOfMarker(row.marker);
    return task === null || (row.archivedAt !== null) !== options.archived
      ? []
      : [
          {
            threadId: ThreadId.make(row.id),
            projectId: ProjectId.make(row.projectId),
            title: row.title,
            archivedAt: row.archivedAt,
            task,
            pullRequests: row.pullRequests,
            issues: row.issues,
          },
        ];
  });
});

export const layer = Layer.effect(
  BoardThreadRows,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return BoardThreadRows.of({
      list: Effect.fn("BoardThreadRows.list")((options) =>
        listBoardThreadRows(options).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
    });
  }),
);
