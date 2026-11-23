import {
  ThreadIssueKey,
  ThreadPullRequestKey,
  threadIssueKeysEqual,
  type DeliveryError,
  type DeliveryResponse,
  type LinkedBoardTask,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { threadPullRequestKeysEqual } from "../sourceControl/threadPullRequests.ts";
import { listBoardThreadRows, type BoardThreadRow } from "./boardThreadRows.ts";

const PullRequestLinks = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({ ...ThreadPullRequestKey.fields, source: Schema.optional(Schema.String) }),
  ),
);
const IssueLinks = Schema.fromJsonString(Schema.Array(ThreadIssueKey));
const decodePullRequestLinks = Schema.decodeUnknownOption(PullRequestLinks);
const decodeIssueLinks = Schema.decodeUnknownOption(IssueLinks);
const decodeTitles = Schema.decodeUnknownOption(
  Schema.Struct({
    lanes: Schema.Array(
      Schema.Struct({
        cards: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
      }),
    ),
  }),
);

const linksPullRequest = (key: ThreadPullRequestKey) => (row: BoardThreadRow) =>
  Option.getOrElse(decodePullRequestLinks(row.pullRequests), () => []).some(
    // A link the stack dismissed is not shown on an ordinary thread either.
    (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, key),
  );
const linksIssue = (key: ThreadIssueKey) => (row: BoardThreadRow) =>
  Option.getOrElse(decodeIssueLinks(row.issues), () => []).some((link) =>
    threadIssueKeysEqual(link, key),
  );

/**
 * The board task conversations linked to a pull request or an issue, found by their marker and
 * named by their task. A task the engine does not list (deleted, moved, or the engine away) keeps
 * the title its thread was made with; an archived conversation is told as ended. Never an error.
 */
export const linkedBoardTasks = Effect.fn("linkedBoardTasks")(function* (
  link: { readonly pullRequest: ThreadPullRequestKey } | { readonly issue: ThreadIssueKey },
  readLanes: Effect.Effect<DeliveryResponse, DeliveryError> | null,
): Effect.fn.Return<ReadonlyArray<LinkedBoardTask>, never, SqlClient.SqlClient> {
  const linked =
    "pullRequest" in link ? linksPullRequest(link.pullRequest) : linksIssue(link.issue);
  const list = (archived: boolean) =>
    listBoardThreadRows({ archived }).pipe(
      Effect.orElseSucceed((): ReadonlyArray<BoardThreadRow> => []),
    );
  const rows = [...(yield* list(false)), ...(yield* list(true))].filter(linked);
  if (rows.length === 0) return [];
  const lanes =
    readLanes === null
      ? Option.none()
      : yield* readLanes.pipe(
          Effect.map((response) => decodeTitles(response.body)),
          Effect.orElseSucceed(() => Option.none()),
        );
  const titles = new Map(
    Option.isSome(lanes)
      ? lanes.value.lanes.flatMap((lane) => lane.cards.map((card) => [card.id, card.title]))
      : [],
  );
  return rows.map((row) => ({
    board: row.task.board,
    taskId: row.task.id,
    title: titles.get(row.task.id) ?? row.title,
    ended: row.archivedAt !== null,
  }));
});
