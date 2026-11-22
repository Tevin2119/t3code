import type {
  DeliveryArchivedBoardThreads,
  DeliveryError,
  DeliveryResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { boardThreadStanding, LANES_PATH } from "./BoardTaskThreads.ts";
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

// The archive list is also read when a project is removed: the engine is never waited on for long.
const ENGINE_WAIT = "3 seconds";

type ArchivedThread = DeliveryArchivedBoardThreads["threads"][number];

/**
 * The archived conversations of board tasks, each with how its task stands in the engine. A
 * restore only helps a thread whose task can still take it: `open`. A task the engine does not
 * list is `deleted` once the engine says so itself (404), and `unknown` while it does not answer,
 * so a slow or absent engine never offers a restore and never calls a task deleted.
 */
export const archivedBoardThreads = Effect.fn("archivedBoardThreads")(function* (
  environmentId: string,
  read: ((path: string) => Effect.Effect<DeliveryResponse, DeliveryError>) | null,
) {
  const rows = yield* listBoardThreadRows({ archived: true });
  const lanes =
    read === null || rows.length === 0
      ? Option.none()
      : yield* read(LANES_PATH).pipe(
          Effect.map((response) => decodeCards(response.body)),
          Effect.orElseSucceed(() => Option.none()),
          Effect.timeoutOption(ENGINE_WAIT),
          Effect.map(Option.flatten),
        );
  const cards = new Map(
    Option.isSome(lanes)
      ? lanes.value.lanes.flatMap((lane) => lane.cards.map((card) => [card.id, card] as const))
      : [],
  );
  const taskOf = Effect.fn("archivedBoardThreads.taskOf")(function* (
    row: (typeof rows)[number],
  ): Effect.fn.Return<ArchivedThread["task"]> {
    if (read === null || Option.isNone(lanes)) return "unknown";
    const card = cards.get(row.task.id);
    if (card === undefined) {
      const gone = yield* read(`/api/tasks/${row.task.id}`).pipe(
        Effect.as(false),
        Effect.catch((error) => Effect.succeed(error.status === 404)),
        Effect.timeoutOption(ENGINE_WAIT),
      );
      return Option.getOrElse(gone, () => false) ? "deleted" : "unknown";
    }
    const standing = boardThreadStanding(card, environmentId, row.threadId);
    return standing === "linked" || standing === "free" ? "open" : "held";
  });
  const threads = yield* Effect.forEach(
    rows,
    (row) =>
      taskOf(row).pipe(
        Effect.map((task): ArchivedThread => ({
          threadId: row.threadId,
          projectId: row.projectId,
          title: row.title,
          archivedAt: row.archivedAt ?? "",
          board: row.task.board,
          taskId: row.task.id,
          task,
        })),
      ),
    { concurrency: 4 },
  );
  return { threads };
});
