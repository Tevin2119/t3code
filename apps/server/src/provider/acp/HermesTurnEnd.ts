/**
 * How a turn of Hermes really ended.
 *
 * When its provider cannot be reached Hermes gives up after a few tries,
 * writes a sentence that says so as its answer, and answers `end_turn` over
 * ACP, as for a turn that ended well. In the store it keeps of its sessions,
 * `state.db`, the last message of such a turn is marked as a failed turn,
 * where the last message of a turn that ended well carries the reason the
 * model gave for stopping.
 *
 * The store is opened for reading and nothing of Hermes is changed. A turn
 * counts as ended well only when the store says so. Where it cannot be read,
 * the turn is not known to have ended well and is not taken for one that did.
 *
 * @module provider/acp/HermesTurnEnd
 */
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export interface HermesTurnEnd {
  readonly endedWell: boolean;
  /** Why the turn did not end well, in words for a person. Undefined when it did. */
  readonly why: string | undefined;
}

export interface HermesLastMessage {
  readonly role: string;
  readonly finishReason: string | undefined;
  readonly displayKind: string | undefined;
  readonly content: string;
}

/** Whether the turn ended well, from the last message Hermes recorded of it. */
export function hermesTurnEndFrom(last: HermesLastMessage | undefined): HermesTurnEnd {
  if (!last) {
    return {
      endedWell: false,
      why: "Hermes answered that the turn had ended, and its own record of the turn could not be read. Hermes answers the same for a turn that failed, so this one is not known to have ended well.",
    };
  }
  if (last.displayKind === "failed_turn") {
    return {
      endedWell: false,
      why: `Hermes reports that the turn failed: ${last.content.slice(0, 400) || "no reason given"}`,
    };
  }
  if (last.role === "assistant" && last.finishReason) return { endedWell: true, why: undefined };
  return {
    endedWell: false,
    why: `Hermes recorded no answer for the turn: its last message is of the ${last.role}, with no reason for stopping.`,
  };
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function readLast(storeFile: string, sessionId: string): HermesLastMessage | undefined {
  // Opened for reading. Hermes writes to it while it runs, and is not kept from it.
  const store = new NodeSqlite.DatabaseSync(storeFile, { readOnly: true });
  try {
    const row = store
      .prepare(
        "select role, finish_reason, display_kind, substr(content, 1, 400) as content from messages where session_id = ? order by id desc limit 1",
      )
      .get(sessionId);
    if (!row) return undefined;
    return {
      role: text(row["role"]) ?? "",
      finishReason: text(row["finish_reason"]),
      displayKind: text(row["display_kind"]),
      content: text(row["content"]) ?? "",
    };
  } finally {
    store.close();
  }
}

/**
 * Reads how the last turn of a session ended. Hermes writes the turn into its
 * store when the turn is over, so the store is asked again for a few seconds
 * while its last message is not an answer.
 */
export const readHermesTurnEnd = Effect.fn("HermesTurnEnd.read")(function* (input: {
  readonly sessionId: string;
  readonly storeFile: string;
}) {
  const attempt = Effect.try({
    try: () => readLast(input.storeFile, input.sessionId),
    catch: () => "unreadable" as const,
  }).pipe(
    Effect.flatMap((last) =>
      last &&
      (last.displayKind === "failed_turn" || (last.role === "assistant" && last.finishReason))
        ? Effect.succeed(last)
        : Effect.fail(last ?? ("unreadable" as const)),
    ),
  );
  return yield* attempt.pipe(
    Effect.retry(Schedule.spaced("300 millis").pipe(Schedule.both(Schedule.recurs(20)))),
    Effect.map(hermesTurnEndFrom),
    Effect.catch((last) =>
      Effect.succeed(hermesTurnEndFrom(last === "unreadable" ? undefined : last)),
    ),
  );
});
