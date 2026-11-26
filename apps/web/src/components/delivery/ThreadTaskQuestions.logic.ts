import { boardTaskIsDone } from "@t3tools/client-runtime/board-task-in-play";

import type { TaskView } from "../../lib/delivery";
import { taskQuestions } from "../../lib/deliveryQuestions";
import { replyDraftKey, type ReplyDraft } from "../../state/deliveryReplyDrafts";

export function questionNeedsAttention(
  row: { canReply: boolean; pending: boolean },
  draft: ReplyDraft | undefined,
  sending = false,
) {
  return Boolean(
    row.canReply ||
    row.pending ||
    sending ||
    (draft && (draft.text.length > 0 || draft.option !== null || draft.uncertain)),
  );
}

export function taskHasReplyDraft(
  environmentId: string,
  taskId: string,
  drafts: Readonly<Record<string, ReplyDraft>>,
  pending: Readonly<Record<string, boolean>>,
) {
  const prefix = `${JSON.stringify([environmentId, taskId]).slice(0, -1)},`;
  return [...Object.keys(drafts), ...Object.keys(pending)].some(
    (key) =>
      key.startsWith(prefix) &&
      questionNeedsAttention({ canReply: false, pending: false }, drafts[key], pending[key]),
  );
}

/** Tasks whose engine record the banner reads: every one with a question waiting on the person. */
export function questionSummaryTasks<T extends { id: string; questions: number }>(
  environmentId: string,
  tasks: ReadonlyArray<T>,
  drafts: Readonly<Record<string, ReplyDraft>>,
  pending: Readonly<Record<string, boolean>>,
) {
  return tasks.filter(
    (task) => task.questions > 0 || taskHasReplyDraft(environmentId, task.id, drafts, pending),
  );
}

export function waitingQuestionKeys(
  environmentId: string,
  task: TaskView,
  drafts: Readonly<Record<string, ReplyDraft>>,
  pending: Readonly<Record<string, boolean>>,
) {
  return taskQuestions(task).flatMap((row) => {
    const key = replyDraftKey(environmentId, task.id, row.question.seq!);
    return !row.pending && !pending[key] && questionNeedsAttention(row, drafts[key]) ? [key] : [];
  });
}

export function threadTaskBannerDismissed(
  dismissedQuestions: ReadonlyArray<string> | undefined,
  waitingQuestions: ReadonlyArray<string>,
) {
  if (dismissedQuestions === undefined) return false;
  const dismissed = new Set(dismissedQuestions);
  const dismissedTasks = new Set(dismissedQuestions.map(questionTaskKey));
  return waitingQuestions.every(
    (key) => dismissed.has(key) || dismissed.has(questionTaskKey(key)) || dismissedTasks.has(key),
  );
}

function questionTaskKey(key: string) {
  return JSON.stringify((JSON.parse(key) as unknown[]).slice(0, 2));
}

export function resolveDismissedQuestionKeys(
  dismissed: ReadonlyArray<string>,
  waitingKeys: ReadonlyArray<string>,
  loadedTaskKeys: ReadonlyArray<string>,
) {
  const loaded = new Set(loadedTaskKeys);
  if (!dismissed.some((key) => loaded.has(key))) return dismissed;
  // An unloaded task is dismissed through its first record, then only those question identities.
  return dismissed.flatMap((key) =>
    loaded.has(key) ? waitingKeys.filter((waiting) => questionTaskKey(waiting) === key) : [key],
  );
}

/** Only work in play is listed, first what needs the person; finished tasks live on the board. */
export function listedThreadTasks<T extends { lane: string; state: string }>(
  tasks: ReadonlyArray<T>,
  needsAttention: (task: T) => boolean,
) {
  return tasks
    .filter((task) => !boardTaskIsDone(task) || needsAttention(task))
    .sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)));
}
