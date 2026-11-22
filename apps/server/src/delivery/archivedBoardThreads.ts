import type {
  DeliveryArchivedBoardThreads,
  DeliveryError,
  DeliveryResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { boardThreadStanding, LANES_PATH, movedTaskStanding } from "./BoardTaskThreads.ts";
import { listBoardThreadRows } from "./boardThreadRows.ts";

const decodeCards = Schema.decodeUnknownOption(
  Schema.Struct({
    lanes: Schema.Array(
      Schema.Struct({
        cards: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            state: Schema.String,
            boardThread: Schema.optional(
              Schema.NullOr(
                Schema.Struct({ environmentId: Schema.String, threadId: Schema.String }),
              ),
            ),
          }),
        ),
      }),
    ),
  }),
);

// One wait for the whole engine check. Removing a project reads this list too, with a two second
// deadline of its own: past this wait every task is unknown and the rows are still answered.
const ENGINE_WAIT = "1500 millis";

type ArchivedThread = DeliveryArchivedBoardThreads["threads"][number];

/**
 * The archived conversations of board tasks, each with how its task stands in the engine. A
 * restore only helps a thread whose task can still take it: `open`. A task the lanes do not list
 * is `deleted` on the engine's 404, judged by its own detail when that says it moved away, and
 * `unknown` otherwise: a slow or absent engine never offers a restore or calls a task deleted.
 */
export const archivedBoardThreads = Effect.fn("archivedBoardThreads")(function* (
  environmentId: string,
  read: ((path: string) => Effect.Effect<DeliveryResponse, DeliveryError>) | null,
) {
  const rows = yield* listBoardThreadRows({ archived: true });
  type Row = (typeof rows)[number];
  const check = Effect.fn("archivedBoardThreads.check")(function* (
    ask: (path: string) => Effect.Effect<DeliveryResponse, DeliveryError>,
  ) {
    const lanes = yield* ask(LANES_PATH).pipe(
      Effect.map((response) => decodeCards(response.body)),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(lanes)) return new Map<Row, ArchivedThread["task"]>();
    const cards = new Map(
      lanes.value.lanes.flatMap((lane) => lane.cards.map((card) => [card.id, card] as const)),
    );
    const taskOf = (row: Row): Effect.Effect<ArchivedThread["task"]> => {
      const told = (standing: ReturnType<typeof boardThreadStanding>) =>
        standing === "linked" || standing === "free" ? ("open" as const) : ("held" as const);
      const card = cards.get(row.task.id);
      if (card !== undefined) {
        return Effect.succeed(told(boardThreadStanding(card, environmentId, row.threadId)));
      }
      return ask(`/api/tasks/${row.task.id}`).pipe(
        Effect.map((response) => {
          const standing = movedTaskStanding(response.body, environmentId, row.threadId);
          return standing === null ? ("unknown" as const) : told(standing);
        }),
        Effect.catch((error) =>
          Effect.succeed(error.status === 404 ? ("deleted" as const) : ("unknown" as const)),
        ),
      );
    };
    return new Map(
      yield* Effect.forEach(
        rows,
        (row) => taskOf(row).pipe(Effect.map((task) => [row, task] as const)),
        { concurrency: 4 },
      ),
    );
  });
  const tasks =
    read === null || rows.length === 0
      ? Option.none()
      : yield* check(read).pipe(Effect.timeoutOption(ENGINE_WAIT));
  return {
    threads: rows.map((row): ArchivedThread => ({
      threadId: row.threadId,
      projectId: row.projectId,
      title: row.title,
      archivedAt: row.archivedAt ?? "",
      board: row.task.board,
      taskId: row.task.id,
      task: Option.match(tasks, {
        onNone: () => "unknown" as const,
        onSome: (found) => found.get(row) ?? "unknown",
      }),
    })),
  };
});
