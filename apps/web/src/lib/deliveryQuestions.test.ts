import { describe, expect, it } from "vite-plus/test";
import { parseTask } from "./delivery";
import { answerState, engineAnswer, taskQuestions } from "./deliveryQuestions";

const question = (seq: number, state = "open") => ({
  id: `m${seq}`,
  seq,
  source: "message",
  kind: "question",
  state,
  by: "planner",
  text: `Question ${seq}`,
});
const reply = (state: string) => ({
  id: "m3",
  seq: 3,
  source: "message",
  kind: "answer",
  replyTo: 1,
  state,
  by: "full auto",
  text: "Use the existing thread",
  revision: state === "applied" ? 2 : null,
});
function record(timeline: unknown[], questions: unknown[] = [], state = "intake") {
  return parseTask({ id: "task-a", card: {}, state, timeline, questions })!;
}

describe("engine question projection", () => {
  it("reconstructs attributed answers after reopen and respects sibling closure", () => {
    const body = {
      id: "task-a",
      card: {},
      state: "intake",
      questions: [],
      timeline: [
        question(1, "answered"),
        question(2, "closed"),
        reply("applied"),
        {
          id: "m4",
          seq: 4,
          source: "message",
          kind: "message",
          sender: "coordinator",
          replyTo: 3,
          text: "The task is back in triage.",
        },
      ],
    };
    const rows = taskQuestions(parseTask(JSON.parse(JSON.stringify(body)))!);
    expect(rows.map((row) => row.canReply)).toEqual([false, false]);
    expect(rows[0]!.replies[0]!.by).toBe("full auto");
    expect(answerState(rows[0]!.replies[0]!)).toBe("Applied as revision 2");
    expect(rows[0]!.continuation[0]!.text).toBe("The task is back in triage.");
    expect(rows[1]!.status).toContain("Closed by the engine");
  });
  it("binds an older question explicitly and sends strict options without free text", () => {
    const rows = taskQuestions(
      record(
        [question(1), question(2)],
        [{ seq: 1, options: [{ label: "Keep", meaning: "Keep native navigation" }] }, { seq: 2 }],
      ),
    );
    expect(rows[0]!.canReply).toBe(true);
    expect(rows[0]!.options).toEqual([{ label: "Keep", meaning: "Keep native navigation" }]);
    expect(engineAnswer(rows[0]!.question.seq!, "Sam", "ignored", "Keep")).toEqual({
      kind: "answer",
      replyTo: 1,
      by: "Sam",
      option: "Keep",
    });
    expect(engineAnswer(1, "Sam", "  Keep it  ", null)).toEqual({
      kind: "answer",
      replyTo: 1,
      by: "Sam",
      text: "Keep it",
    });
  });
  it("blocks another reply while a received answer waits for its step", () => {
    const [row] = taskQuestions(
      record([question(1), { ...reply("received"), by: "Sam" }], [{ seq: 1 }]),
    );
    expect(row!.canReply).toBe(false);
    expect(row!.status).toContain("waiting to be applied");
    expect(answerState(row!.replies[0]!)).toBe("Recorded; not yet applied");
  });
  it("keeps superseded full-auto answers without treating them as applied", () => {
    const [row] = taskQuestions(record([question(1, "closed"), reply("closed")]));
    expect(row!.canReply).toBe(false);
    expect(answerState(row!.replies[0]!)).toBe("Superseded; not applied");
  });
  it.each(["closed", "rejected", "merged", "moving", "moved", "draft"])(
    "never offers a reply on a %s task",
    (state) => {
      expect(taskQuestions(record([question(1)], [{ seq: 1 }], state))[0]!.canReply).toBe(false);
    },
  );
  it("does not mistake ordinary messages or event ids for question records", () => {
    const rows = taskQuestions(
      record([
        { ...question(1), source: "event" },
        { ...question(2), kind: "message" },
      ]),
    );
    expect(rows).toEqual([]);
  });
});

it("allows a person to take over a waiting automatic answer", () => {
  const task = parseTask({
    id: "task-a",
    card: {},
    state: "needs-decision",
    questions: [{ seq: 1 }],
    timeline: [question(1), reply("received")],
  })!;
  expect(taskQuestions(task)[0]!.canReply).toBe(true);
  expect(taskQuestions(task)[0]!.status).toContain("you can reply instead");
});
