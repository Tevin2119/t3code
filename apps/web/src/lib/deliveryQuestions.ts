import { fullAutoAttribution, type TaskView, type TimelineEntry } from "./delivery";

/** The engine record owns both history and reply eligibility, including sibling closures. */
export function taskQuestions(task: TaskView) {
  const messages = task.timeline.filter((entry) => entry.source === "message");
  const answers = messages.filter((entry) => entry.kind === "answer");
  return messages
    .filter((entry) => entry.kind === "question" && entry.seq !== null)
    .map((question) => {
      const replies = answers.filter((entry) => entry.replyTo === question.seq);
      const open = task.questions.find((entry) => entry.seq === question.seq);
      const pending = replies.some(
        (entry) => ["received", "seen"].includes(entry.state ?? "") && !fullAutoAttribution(entry),
      );
      const pendingAuto = replies.some(
        (entry) => ["received", "seen"].includes(entry.state ?? "") && fullAutoAttribution(entry),
      );
      const applied = replies.some((entry) => entry.state === "applied");
      const closedTask = ["draft", "closed", "rejected", "merged", "moving", "moved"].includes(
        task.state,
      );
      const canReply =
        Boolean(open) && question.state === "open" && !pending && !applied && !closedTask;
      const status = pending
        ? "Answer recorded; waiting to be applied"
        : applied || question.state === "answered"
          ? "Answered"
          : question.state === "closed"
            ? "Closed by the engine; this round no longer needs an answer"
            : closedTask
              ? `Replies unavailable: task is ${task.state}`
              : canReply
                ? pendingAuto
                  ? "Automatic answer waiting; you can reply instead"
                  : "Waiting for your answer"
                : "Not waiting for an answer";
      const replyIds = new Set(replies.map((entry) => entry.seq));
      return {
        question,
        replies,
        // The engine tells whether a received answer waits or has become a task revision.
        continuation: messages.filter(
          (entry) =>
            entry.sender === "coordinator" && entry.replyTo !== null && replyIds.has(entry.replyTo),
        ),
        options: open?.options ?? [],
        canReply,
        pending,
        status,
      };
    });
}

export function answerState(entry: TimelineEntry): string {
  switch (entry.state) {
    case "received":
    case "seen":
      return "Recorded; not yet applied";
    case "applied":
      return entry.revision === null
        ? "Applied to the task"
        : `Applied as revision ${entry.revision}`;
    case "closed":
      return "Superseded; not applied";
    default:
      return entry.state ?? "Recorded";
  }
}

export function engineAnswer(replyTo: number, by: string, text: string, option: string | null) {
  return { kind: "answer", replyTo, by, ...(option === null ? { text: text.trim() } : { option }) };
}
