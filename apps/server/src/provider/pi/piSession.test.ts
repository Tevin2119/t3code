import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  decodePiResumeCursor,
  piCursorFrom,
  piRestoredProblem,
  piRestorePlan,
  piSessionStateFrom,
  type PiResumeCursor,
} from "./piSession.ts";

const cursor: PiResumeCursor = {
  schemaVersion: 1,
  sessionFile: "C:/sessions/2026_a.jsonl",
  sessionId: "a",
  messages: 3,
};

describe("piRestorePlan", () => {
  it("starts a thread that has no session as a new one", () => {
    expect(piRestorePlan(undefined, () => true)).toEqual({ restore: false });
  });

  it("has nothing to take up in a session that never held a message", () => {
    expect(piRestorePlan({ ...cursor, messages: 0 }, () => false)).toEqual({ restore: false });
  });

  it("opens the session again when its file is there", () => {
    expect(piRestorePlan(cursor, (file) => file === cursor.sessionFile)).toEqual({ restore: true });
  });

  it("does not start when the file is gone, since pi would start a new session and say nothing", () => {
    const plan = piRestorePlan(cursor, () => false);
    expect("problem" in plan ? plan.problem : "").toContain("is not there any more");
    expect("problem" in plan ? plan.problem : "").toContain("Nothing was started");
  });
});

describe("piRestoredProblem", () => {
  it("finds no problem in the same session with the messages it had, or more", () => {
    expect(piRestoredProblem(cursor, { sessionFile: "x", sessionId: "a", messages: 3 })).toBe(
      undefined,
    );
    expect(piRestoredProblem(cursor, { sessionFile: "x", sessionId: "a", messages: 5 })).toBe(
      undefined,
    );
  });

  it("names another session", () => {
    expect(piRestoredProblem(cursor, { sessionFile: "x", sessionId: "b", messages: 3 })).toContain(
      "another session",
    );
  });

  it("names a session that came back with fewer messages, or empty", () => {
    expect(piRestoredProblem(cursor, { sessionFile: "x", sessionId: "a", messages: 0 })).toContain(
      "with 0 message(s), where it held 3",
    );
  });

  it("does not take silence for the session of the thread", () => {
    expect(
      piRestoredProblem(cursor, { sessionFile: undefined, sessionId: undefined, messages: 0 }),
    ).toContain("did not say which session");
  });
});

describe("the cursor", () => {
  it("is made of what pi says of its session", () => {
    const state = piSessionStateFrom({
      sessionFile: "C:/sessions/2026_a.jsonl",
      sessionId: "a",
      messageCount: 3,
      thinkingLevel: "high",
    });
    expect(piCursorFrom(state)).toEqual(cursor);
    expect(piCursorFrom(piSessionStateFrom({ messageCount: 3 }))).toBe(undefined);
  });

  it("is read back, and what is not one is not taken for one", () => {
    expect(Option.isSome(decodePiResumeCursor(cursor))).toBe(true);
    expect(Option.isNone(decodePiResumeCursor({ schemaVersion: 1, sessionId: "a" }))).toBe(true);
  });
});
