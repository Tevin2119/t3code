import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import {
  fullAutoAttribution,
  parseTask,
  type DeliveryCard,
  type TaskView,
} from "../../lib/delivery";
import { answerState, engineAnswer, taskQuestions } from "../../lib/deliveryQuestions";
import {
  deliveryEnvironment,
  useDeliveryAct,
  useDeliveryRead,
  usePersonName,
} from "../../state/delivery";
import {
  EMPTY_REPLY,
  replyDraftKey,
  useDeliveryReplyDrafts,
} from "../../state/deliveryReplyDrafts";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Textarea } from "../ui/textarea";
import { questionNeedsAttention, taskHasReplyDraft } from "./ThreadTaskQuestions.logic";

export function ThreadTaskQuestions({
  environmentId,
  tasks,
  summaryTaskIds = [],
}: {
  environmentId: EnvironmentId;
  tasks: ReadonlyArray<DeliveryCard>;
  summaryTaskIds?: ReadonlyArray<string>;
}) {
  const [visible, setVisible] = useState(10);
  const drafts = useDeliveryReplyDrafts((state) => state.drafts);
  const pending = useDeliveryReplyDrafts((state) => state.pending);
  const needsAttention = (task: DeliveryCard) =>
    task.questions > 0 || taskHasReplyDraft(environmentId, task.id, drafts, pending);
  const ordered = [...tasks].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)));
  return (
    <div className="space-y-4" data-thread-task-questions>
      {ordered.slice(0, visible).map((task) => (
        <TaskQuestions
          key={task.id}
          environmentId={environmentId}
          card={task}
          summaryManaged={summaryTaskIds.includes(task.id)}
        />
      ))}
      {tasks.length > visible ? (
        <Button variant="ghost" size="sm" onClick={() => setVisible(visible + 10)}>
          Show questions from {Math.min(10, tasks.length - visible)} more linked tasks
        </Button>
      ) : null}
      {tasks.length === 500 ? (
        <p className="text-xs text-muted-foreground">
          The engine returned its limit of 500 linked tasks. Older tasks remain available on the
          Board.
        </p>
      ) : null}
    </div>
  );
}

function TaskQuestions({
  environmentId,
  card,
  summaryManaged,
}: {
  environmentId: EnvironmentId;
  card: DeliveryCard;
  summaryManaged: boolean;
}) {
  const read = useDeliveryRead(environmentId, `/api/tasks/${card.id}`);
  const { refresh } = read;
  const summaryVersion = JSON.stringify([
    card.updated,
    card.questions,
    card.unanswered,
    card.state,
    card.revision,
    card.run?.state,
  ]);
  const lastSummary = useRef(summaryVersion);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh engine history when its polled summary changes; idle historical tasks need no full-history timer.
  useEffect(() => {
    if (lastSummary.current !== summaryVersion) {
      lastSummary.current = summaryVersion;
      if (!summaryManaged) refresh();
    }
  }, [summaryVersion, refresh, summaryManaged]);
  const task = parseTask(read.body);
  const drafts = useDeliveryReplyDrafts((state) => state.drafts);
  const pending = useDeliveryReplyDrafts((state) => state.pending);
  if (!task) {
    return read.error ? (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground" role="status">
          Task #{card.number} questions unavailable: {read.error}
        </p>
        <Button size="xs" variant="ghost" onClick={refresh}>
          Retry reading task
        </Button>
      </div>
    ) : null;
  }
  const needsAttention = (row: ReturnType<typeof taskQuestions>[number]) => {
    const key = replyDraftKey(environmentId, task.id, row.question.seq!);
    return questionNeedsAttention(row, drafts[key], pending[key]);
  };
  const rows = taskQuestions(task).sort(
    (a, b) => Number(needsAttention(b)) - Number(needsAttention(a)),
  );
  if (rows.length === 0) return null;
  return (
    <section className="space-y-3" aria-label={`Questions for task ${task.number}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Link to="/board" search={{ environment: environmentId, task: task.id }}>
          Task #{task.number}: {task.title}
        </Link>
        <span>
          {card.questions > 0 ? "Engine record · refreshes every 5 seconds" : "Engine record"}
        </span>
        <Button size="xs" variant="ghost" onClick={refresh}>
          Refresh
        </Button>
      </div>
      {read.error ? (
        <p role="alert" className="text-xs text-warning">
          The record could not refresh. Replies are unavailable until it reconnects.
        </p>
      ) : null}
      {rows.map((row) => (
        <QuestionCard
          key={row.question.id}
          environmentId={environmentId}
          task={task}
          row={row}
          unavailable={Boolean(read.error)}
          refresh={read.refresh}
        />
      ))}
    </section>
  );
}

function QuestionCard({
  environmentId,
  task,
  row,
  unavailable,
  refresh,
}: {
  environmentId: EnvironmentId;
  task: TaskView;
  row: ReturnType<typeof taskQuestions>[number];
  unavailable: boolean;
  refresh: () => void;
}) {
  const person = usePersonName();
  const act = useDeliveryAct(environmentId, "answer task question");
  const allowed = useAtomValue(deliveryEnvironment.act.permissionAtom(environmentId));
  const key = replyDraftKey(environmentId, task.id, row.question.seq!);
  const draft = useDeliveryReplyDrafts((state) => state.drafts[key] ?? EMPTY_REPLY);
  const pending = useDeliveryReplyDrafts((state) => state.pending[key] === true);
  const update = useDeliveryReplyDrafts((state) => state.update);
  const begin = useDeliveryReplyDrafts((state) => state.begin);
  const finish = useDeliveryReplyDrafts((state) => state.finish);
  const discard = useDeliveryReplyDrafts((state) => state.discard);
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Keep a successful receipt visible even before the next poll, without claiming continuation.
  const [accepted, setAccepted] = useState(false);
  // The person's own open/closed choice; null follows whether the question still needs them.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const canReply = row.canReply && allowed && !unavailable && !accepted;
  const hasDraft = draft.text.length > 0 || draft.option !== null || draft.uncertain;
  const expanded = userOpen ?? (questionNeedsAttention(row, draft, pending) || accepted || editing);
  const matchingAnswer =
    draft.uncertain &&
    row.replies.some(
      (reply) =>
        reply.by === (person || "person") &&
        !fullAutoAttribution(reply) &&
        (draft.option === null
          ? reply.text.trim() === draft.text.trim()
          : reply.text.startsWith(`${draft.option}: `)),
    );
  const optionOffered =
    draft.option === null || row.options.some((option) => option.label === draft.option);
  const send = async () => {
    if (
      !canReply ||
      pending ||
      !optionOffered ||
      (!draft.text.trim() && draft.option === null) ||
      !begin(key)
    )
      return;
    setProblem(null);
    const result = await act(
      `/api/tasks/${task.id}/messages`,
      engineAnswer(row.question.seq!, person, draft.text, draft.option),
    );
    // A transport failure/5xx may have happened after the engine stored the answer.
    const rejected =
      !result.ok && result.status !== null && result.status >= 400 && result.status < 500;
    finish(key, result.ok ? "accepted" : rejected ? "rejected" : "unknown");
    if (result.ok) {
      setAccepted(true);
      setEditing(false);
    } else {
      setProblem(result.why);
    }
    refresh();
  };
  const excerpt = row.question.text.split("\n").find((line) => line.trim()) ?? "";
  return (
    <article
      className="rounded-lg border border-border bg-card"
      data-engine-question={row.question.seq}
    >
      <Collapsible open={expanded} onOpenChange={setUserOpen}>
        <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring">
          <ChevronDownIcon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180"
          />
          <span className="shrink-0 text-xs text-muted-foreground">
            {row.question.by} asked · Q{row.question.seq}
          </span>
          <Badge variant="outline" size="sm" className="shrink-0">
            {row.status}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground group-data-panel-open:hidden">
            {excerpt}
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel animate={false}>
          <div className="space-y-3 px-4 pb-4">
            <ChatMarkdown
              text={row.question.text}
              cwd={undefined}
              environmentId={environmentId}
              parseRawHtml={false}
              allowMedia={false}
            />
            {row.replies.map((reply) => {
              const auto = fullAutoAttribution(reply);
              return (
                <div key={reply.id} className="space-y-2 border-l-2 border-border pl-3">
                  <p className="text-xs text-muted-foreground">
                    {auto ? `Full auto${auto.by ? `, enabled by ${auto.by}` : ""}` : reply.by} ·{" "}
                    {answerState(reply)}
                  </p>
                  <ChatMarkdown
                    text={reply.text}
                    cwd={undefined}
                    environmentId={environmentId}
                    parseRawHtml={false}
                    allowMedia={false}
                  />
                </div>
              );
            })}
            {row.continuation.map((entry) => (
              <p key={entry.id} className="text-xs text-muted-foreground">
                {entry.text}
              </p>
            ))}
            {accepted && row.replies.length === 0 ? (
              <p role="status" className="text-xs text-muted-foreground">
                Answer recorded. Refreshing its application state.
              </p>
            ) : null}
            {problem ? (
              <p role="alert" className="text-xs text-warning">
                {problem} Your draft is kept.
              </p>
            ) : null}
            {!allowed ? (
              <p className="text-xs text-muted-foreground">
                This connection cannot answer engine questions.
              </p>
            ) : null}
            {canReply && !editing && !hasDraft ? (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                Reply to Q{row.question.seq}
              </Button>
            ) : null}
            {editing || hasDraft ? (
              <div className="space-y-2">
                <label
                  className="text-xs text-muted-foreground"
                  htmlFor={`engine-reply-${task.id}-${row.question.seq}`}
                >
                  {canReply ? "Replying" : "Draft kept"} for Q{row.question.seq} ·{" "}
                  {person || "person"}
                </label>
                {row.options.length > 0 && canReply ? (
                  <div className="flex flex-wrap gap-2">
                    {row.options.map((option) => (
                      <Button
                        key={option.label}
                        size="sm"
                        variant={draft.option === option.label ? "default" : "outline"}
                        disabled={pending || draft.uncertain}
                        onClick={() => update(key, { option: option.label, text: "" })}
                      >
                        {option.label}
                      </Button>
                    ))}
                    {draft.option !== null ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending || draft.uncertain}
                        onClick={() => update(key, { option: null })}
                      >
                        Answer in my own words
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {draft.option !== null ? (
                  <p className="text-sm">
                    {draft.option}:{" "}
                    {row.options.find((option) => option.label === draft.option)?.meaning ??
                      "The option is no longer offered."}
                  </p>
                ) : (
                  <Textarea
                    id={`engine-reply-${task.id}-${row.question.seq}`}
                    aria-label={`Reply to question ${row.question.seq}`}
                    value={draft.text}
                    disabled={pending}
                    readOnly={!canReply || draft.uncertain}
                    onChange={(event) => update(key, { text: event.target.value, option: null })}
                  />
                )}
                {draft.uncertain && !pending ? (
                  <p role="status" className="text-xs text-warning">
                    {matchingAnswer
                      ? "The engine now shows a matching answer from you above. This retained draft will not be sent again; discard it when satisfied."
                      : "Delivery is unconfirmed. Refresh the engine record to check what arrived. Your draft is retained and will not be replayed automatically."}
                  </p>
                ) : null}
                {!canReply && hasDraft && !matchingAnswer ? (
                  <p className="text-xs text-muted-foreground">
                    This reply cannot be sent. The question or task changed; your draft remains
                    here.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {canReply ? (
                    <Button
                      size="sm"
                      disabled={
                        pending ||
                        draft.uncertain ||
                        !optionOffered ||
                        (!draft.text.trim() && draft.option === null)
                      }
                      onClick={() => void send()}
                    >
                      {pending ? "Sending reply" : "Send reply"}
                    </Button>
                  ) : null}
                  {draft.uncertain && !pending ? (
                    <Button size="sm" variant="outline" onClick={refresh}>
                      Refresh engine record
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      discard(key);
                      setEditing(false);
                      setProblem(null);
                    }}
                  >
                    Discard draft
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </article>
  );
}
