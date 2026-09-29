/**
 * How a turn of Kimi really ended.
 *
 * Over ACP Kimi answers `end_turn` for a turn that ended well and for one
 * that failed: its protocol version has no word for a failure. A call to the
 * model that was refused ten times therefore looks like an answer. What
 * happened is in the record Kimi keeps of its own session, `wire.jsonl`,
 * whose last `turn.ended` names the reason and the error.
 *
 * The record is read and nothing of Kimi is changed. A turn counts as ended
 * well only when the record says so. Where the record cannot be read, the
 * turn is not known to have ended well and is not taken for one that did.
 *
 * @module provider/acp/KimiTurnEnd
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface KimiTurnEnd {
  readonly endedWell: boolean;
  /** Why the turn did not end well, in words for a person. Undefined when it did. */
  readonly why: string | undefined;
  readonly file: string | undefined;
}

/** The last `turn.ended` of a record, or undefined when it holds none that can be read. */
export function lastKimiTurnEnded(record: string): Record<string, unknown> | undefined {
  const lines = record.split("\n");
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at];
    if (!line || !line.includes('"turn.ended"')) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (typeof event === "object" && event !== null && "type" in event) {
        if ((event as { type: unknown }).type === "turn.ended") {
          return event as Record<string, unknown>;
        }
      }
    } catch {
      // A line that is being written is not read yet.
    }
  }
  return undefined;
}

/** Whether the turn ended well, from what Kimi recorded of it. */
export function kimiTurnEndFrom(
  event: Record<string, unknown> | undefined,
  file: string | undefined,
): KimiTurnEnd {
  if (!event) {
    return {
      endedWell: false,
      file,
      why: `Kimi answered that the turn had ended, and its own record of the turn could not be read${file ? ` in ${file}` : ""}. Kimi answers the same for a turn that failed, so this one is not known to have ended well.`,
    };
  }
  if (event["reason"] === "completed") return { endedWell: true, why: undefined, file };
  const error =
    typeof event["error"] === "object" && event["error"] !== null
      ? (event["error"] as Record<string, unknown>)
      : undefined;
  const named = error
    ? `${typeof error["code"] === "string" ? error["code"] : "an error"}: ${typeof error["message"] === "string" && error["message"] ? error["message"].slice(0, 400) : "no message"}`
    : typeof event["interruptReason"] === "string"
      ? event["interruptReason"]
      : "no error named";
  const how = event["reason"] === "failed" ? "failed" : `ended as "${String(event["reason"])}"`;
  return { endedWell: false, file, why: `Kimi reports that the turn ${how}: ${named}` };
}

/** The record is asked for this often, a third of a second apart, before it is given up. */
const TIMES_ASKED = 20;

const SESSION_ID = /^[\w-]+$/;

/** Kimi keeps a session in `<home>/sessions/<workspace>/<session>/agents/main/wire.jsonl`. */
const findRecord = Effect.fn("KimiTurnEnd.findRecord")(function* (input: {
  readonly sessionId: string;
  readonly home: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!SESSION_ID.test(input.sessionId)) return undefined;
  const root = path.join(input.home, "sessions");
  const name = input.sessionId.startsWith("session_")
    ? input.sessionId
    : `session_${input.sessionId}`;
  const workspaces = yield* fileSystem
    .readDirectory(root)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  for (const workspace of workspaces) {
    const file = path.join(root, workspace, name, "agents", "main", "wire.jsonl");
    if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) return file;
  }
  return undefined;
});

/**
 * Reads how the last turn of a session ended. The record is written a moment
 * after the answer is sent, so it is asked for again for a few seconds.
 */
export const readKimiTurnEnd = Effect.fn("KimiTurnEnd.read")(function* (input: {
  readonly sessionId: string;
  readonly home: string;
  /** The turns the record held before this one, so that an older end is not read for it. */
  readonly endsBefore?: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  // What the record holds now: the end of this turn, or nothing of it yet.
  const look = Effect.gen(function* () {
    const file = yield* findRecord(input);
    if (!file) return { file, event: undefined };
    const record = yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    const ends = record.split("\n").filter((line) => line.includes('"turn.ended"')).length;
    if (input.endsBefore !== undefined && ends <= input.endsBefore) {
      return { file, event: undefined };
    }
    return { file, event: lastKimiTurnEnded(record) };
  });
  let seen = yield* look;
  for (let asked = 0; asked < TIMES_ASKED && !seen.event; asked += 1) {
    yield* Effect.sleep("300 millis");
    seen = yield* look;
  }
  return kimiTurnEndFrom(seen.event, seen.file);
});

/** How many turns the record of a session holds as ended, before another is started. */
export const countKimiTurnEnds = Effect.fn("KimiTurnEnd.count")(function* (input: {
  readonly sessionId: string;
  readonly home: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const file = yield* findRecord(input);
  if (!file) return 0;
  const record = yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  return record.split("\n").filter((line) => line.includes('"turn.ended"')).length;
});
