/**
 * Taking up the session of a pi thread again.
 *
 * pi keeps a session as a file and opens it with `--session <file>`, with the
 * model it had or with another. Asked for a file that is not there, pi says
 * nothing and starts a session that is new. So the file is looked for before
 * pi is started, and what pi then holds is held against what the thread had:
 * the same session, with no fewer messages. Where that fails the thread is
 * not started, and the reason is said. A thread never goes on in a new
 * session as if it were the old one.
 *
 * @module provider/pi/piSession
 */
import * as Schema from "effect/Schema";

export const PiResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionFile: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  /** How many messages the session held when it was last asked. */
  messages: Schema.Number,
});
export type PiResumeCursor = typeof PiResumeCursor.Type;
export const decodePiResumeCursor = Schema.decodeUnknownOption(PiResumeCursor);

/** What pi says of its session, from `get_state`. */
export interface PiSessionState {
  readonly sessionFile: string | undefined;
  readonly sessionId: string | undefined;
  readonly messages: number | undefined;
}

export function piSessionStateFrom(data: unknown): PiSessionState {
  const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const text = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  return {
    sessionFile: text(record["sessionFile"]),
    sessionId: text(record["sessionId"]),
    messages: typeof record["messageCount"] === "number" ? record["messageCount"] : undefined,
  };
}

export function piCursorFrom(state: PiSessionState): PiResumeCursor | undefined {
  return state.sessionFile && state.sessionId
    ? {
        schemaVersion: 1,
        sessionFile: state.sessionFile,
        sessionId: state.sessionId,
        messages: state.messages ?? 0,
      }
    : undefined;
}

const NOT_STARTED =
  "Nothing was started, so that the thread does not go on without what was said in it. Start a new thread to go on without it.";

/**
 * Whether the session of a thread is to be opened again, and why it cannot
 * be. A session that never held a message has nothing to take up: pi is
 * started as for a new thread.
 */
export function piRestorePlan(
  cursor: PiResumeCursor | undefined,
  fileExists: (file: string) => boolean,
): { readonly restore: false } | { readonly restore: true } | { readonly problem: string } {
  if (!cursor || cursor.messages <= 0) return { restore: false };
  if (!fileExists(cursor.sessionFile)) {
    return {
      problem: `pi cannot take up the conversation of this thread: the file of its session is not there any more (${cursor.sessionFile}). ${NOT_STARTED}`,
    };
  }
  return { restore: true };
}

/** Why what pi holds after it was started is not the session the thread had, or undefined. */
export function piRestoredProblem(
  cursor: PiResumeCursor,
  state: PiSessionState,
): string | undefined {
  if (state.sessionId === undefined) {
    return `pi did not say which session it opened, so the conversation of this thread is not known to be taken up. ${NOT_STARTED}`;
  }
  if (state.sessionId !== cursor.sessionId) {
    return `pi opened another session (${state.sessionId}) than the one of this thread (${cursor.sessionId}). ${NOT_STARTED}`;
  }
  if ((state.messages ?? 0) < cursor.messages) {
    return `pi opened the session of this thread with ${state.messages ?? 0} message(s), where it held ${cursor.messages}. ${NOT_STARTED}`;
  }
  return undefined;
}
