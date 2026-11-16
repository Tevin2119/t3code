import { expect, it } from "vite-plus/test";
import { parseTask } from "../../lib/delivery";
import { replyDraftKey } from "../../state/deliveryReplyDrafts";
import {
  questionNeedsAttention,
  questionSummaryTasks,
  resolveDismissedQuestionKeys,
  taskHasReplyDraft,
  threadTaskBannerDismissed,
  waitingQuestionKeys,
} from "./ThreadTaskQuestions.logic";

it("counts replyable and unsent-draft questions, but not applying, sending or settled history", () => {
  const task = parseTask({
    id: "task-a",
    state: "intake",
    card: {},
    questions: [{ seq: 1 }],
    timeline: [
      ...["open", "open", "closed", "answered"].map((state, index) => ({
        id: `q${index + 1}`,
        source: "message",
        kind: "question",
        seq: index + 1,
        state,
      })),
      { source: "message", kind: "answer", seq: 5, replyTo: 2, state: "received", by: "Sam" },
    ],
  })!;
  const draftKey = replyDraftKey("env-a", task.id, 3);
  const drafts = { [draftKey]: { text: "Kept reply", option: null, uncertain: false } };
  expect(waitingQuestionKeys("env-a", task, drafts, {})).toEqual([
    replyDraftKey("env-a", task.id, 1),
    draftKey,
  ]);
  expect(
    waitingQuestionKeys("env-a", task, drafts, {
      [replyDraftKey("env-a", task.id, 1)]: true,
      [draftKey]: true,
    }),
  ).toEqual([]);
  expect(questionNeedsAttention({ canReply: false, pending: true }, undefined)).toBe(true);
  const applied = {
    ...task,
    timeline: task.timeline.map((entry) =>
      entry.kind === "answer" ? { ...entry, state: "applied" } : entry,
    ),
  };
  expect(waitingQuestionKeys("env-a", applied, drafts, {})).toEqual([
    replyDraftKey("env-a", task.id, 1),
    draftKey,
  ]);
  expect(taskHasReplyDraft("env-a", task.id, drafts, {})).toBe(true);
  expect(taskHasReplyDraft("env-b", task.id, drafts, {})).toBe(false);
  expect(taskHasReplyDraft("env-a", "other-task", drafts, {})).toBe(false);
  expect(questionNeedsAttention({ canReply: false, pending: false }, undefined, true)).toBe(true);
  expect(
    questionNeedsAttention(
      { canReply: false, pending: false },
      { text: "", option: "A", uncertain: false },
    ),
  ).toBe(true);
});

it("keeps dismissal until a new waiting question, including a same-count replacement", () => {
  const first = replyDraftKey("env-a", "task-a", 1);
  const next = replyDraftKey("env-a", "task-a", 2);
  expect(threadTaskBannerDismissed(undefined, [])).toBe(false);
  expect(threadTaskBannerDismissed([], [])).toBe(true);
  expect(threadTaskBannerDismissed([first], [first])).toBe(true);
  expect(threadTaskBannerDismissed([first], [])).toBe(true);
  expect(threadTaskBannerDismissed([first], [next])).toBe(false);
  expect(threadTaskBannerDismissed([first], [first, next])).toBe(false);
  expect(threadTaskBannerDismissed([first], [replyDraftKey("env-a", "task-b", 1)])).toBe(false);
  expect(threadTaskBannerDismissed([first], [replyDraftKey("env-b", "task-a", 1)])).toBe(false);
});

it("dismisses an unloaded task through its first record instead of resurfacing the same question", () => {
  const unloaded = JSON.stringify(["env-a", "task-a"]);
  const first = replyDraftKey("env-a", "task-a", 1);
  expect(threadTaskBannerDismissed([unloaded], [unloaded])).toBe(true);
  expect(threadTaskBannerDismissed([unloaded], [first])).toBe(true);
  expect(threadTaskBannerDismissed([unloaded], [replyDraftKey("env-a", "task-b", 1)])).toBe(false);
  expect(threadTaskBannerDismissed([unloaded], [replyDraftKey("env-b", "task-a", 1)])).toBe(false);
  const dismissed = [unloaded];
  expect(resolveDismissedQuestionKeys(dismissed, [unloaded], [])).toBe(dismissed);
  const resolved = resolveDismissedQuestionKeys(dismissed, [first], [unloaded]);
  expect(resolved).toEqual([first]);
  expect(threadTaskBannerDismissed(resolved, [first])).toBe(true);
  expect(threadTaskBannerDismissed(resolved, [unloaded])).toBe(true);
  expect(threadTaskBannerDismissed(resolved, [replyDraftKey("env-a", "task-a", 2)])).toBe(false);
  expect(resolveDismissedQuestionKeys(dismissed, [], [unloaded])).toEqual([]);
});

it("reads every task with a waiting question, so a dismissed banner can see a new one on any task", () => {
  const tasks = Array.from({ length: 12 }, (_, index) => ({
    id: `task-${index}`,
    questions: index === 7 ? 0 : 1,
  }));
  expect(questionSummaryTasks("env", tasks, {}, {}).map((task) => task.id)).toEqual(
    tasks.filter((task) => task.questions > 0).map((task) => task.id),
  );
});
