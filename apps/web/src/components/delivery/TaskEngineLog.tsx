import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CirclePauseIcon,
  CirclePlayIcon,
  CircleXIcon,
  CornerDownRightIcon,
  FileIcon,
  GitCommitHorizontalIcon,
  ListChecksIcon,
  PencilIcon,
} from "lucide-react";
import { useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { fullAutoAttribution, type TaskView, type TimelineEntry } from "../../lib/delivery";
import { messageStateLabel, sectionOf } from "../../lib/deliveryBoard";
import { cn } from "../../lib/utils";
import { useBoardStore, useDeliveryAct, usePersonName } from "../../state/delivery";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { TaskComposer } from "./TaskComposer";
import { TaskFileList } from "./taskFiles";
import { Avatar, time } from "./taskParts";

const EVENT_ICON: Record<string, typeof CircleDotIcon> = {
  pass: CircleCheckIcon,
  approved: CircleCheckIcon,
  done: CircleCheckIcon,
  checks: ListChecksIcon,
  fail: CircleXIcon,
  rejected: CircleXIcon,
  problem: CircleAlertIcon,
  finding: CircleAlertIcon,
  paused: CirclePauseIcon,
  resumed: CirclePlayIcon,
  submitted: CirclePlayIcon,
  decision: CircleHelpIcon,
  candidate: GitCommitHorizontalIcon,
  file: FileIcon,
  edited: PencilIcon,
  plan: ListChecksIcon,
};

const EVENT_TONE: Record<string, string> = {
  pass: "text-emerald-600 dark:text-emerald-400",
  approved: "text-emerald-600 dark:text-emerald-400",
  fail: "text-rose-600 dark:text-rose-400",
  rejected: "text-rose-600 dark:text-rose-400",
  problem: "text-amber-600 dark:text-amber-400",
  finding: "text-amber-600 dark:text-amber-400",
  decision: "text-fuchsia-600 dark:text-fuchsia-400",
};

const MESSAGE_KIND_LABEL: Record<string, string> = {
  message: "message",
  status: "asked for status",
  answer: "answer",
  change: "change to what is asked",
  note: "note for the record",
  question: "question",
  proposal: "proposed change",
  reply: "reply",
  said: "its part",
  started: "submitted",
  control: "control",
  "decision-needed": "needs your decision",
  error: "problem",
};

/** A link from a line of the log to the section it points at, if it points at one. */
function ShowSection(props: {
  readonly entry: TimelineEntry;
  readonly onShow: ((section: "acceptance" | "plan") => void) | undefined;
}) {
  const section = sectionOf({ kind: props.entry.kind ?? null, text: props.entry.text ?? "" });
  if (!section || !props.onShow) return null;
  return (
    <button
      type="button"
      className="ml-1 cursor-pointer text-primary underline-offset-2 hover:underline"
      onClick={() => props.onShow?.(section)}
      data-task-show={section}
    >
      {section === "acceptance" ? "See the checklist" : "Read the plan"}
    </button>
  );
}

export function FullAutoAttribution({
  entry,
}: {
  readonly entry: Pick<TimelineEntry, "by" | "fullAuto">;
}) {
  const attribution = fullAutoAttribution(entry);
  if (!attribution) return null;
  return (
    <span
      className="inline-flex max-w-full flex-wrap items-center gap-1 wrap-break-word"
      data-full-auto-attribution
    >
      <Badge variant="outline">Full auto</Badge>
      {attribution.by || attribution.since ? (
        <span>
          {attribution.by ? `turned on by ${attribution.by}` : null}
          {attribution.by && attribution.since ? ", " : null}
          {attribution.since ? time(attribution.since) : null}
        </span>
      ) : null}
    </span>
  );
}

function Message(props: {
  readonly onShow?: ((section: "acceptance" | "plan") => void) | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly entry: TimelineEntry;
  readonly repliedTo: TimelineEntry | null;
  readonly onReply: ((entry: TimelineEntry) => void) | undefined;
  readonly onSettle: ((entry: TimelineEntry, accept: boolean) => void) | undefined;
  readonly busy: boolean;
}) {
  const { entry } = props;
  const mine = entry.sender === "person";
  const open = entry.state === "open";
  const state = messageStateLabel(entry.state, entry.revision);
  return (
    <div
      data-timeline-entry={entry.id}
      data-message-kind={entry.kind}
      data-message-state={entry.state ?? ""}
      data-message-from={entry.sender ?? ""}
      className={cn("flex max-w-[88%] gap-2", mine ? "ml-auto flex-row-reverse" : "")}
    >
      <Avatar
        name={entry.by}
        seat={!mine}
        detail={mine ? entry.by : `${entry.by}, ${entry.sender ?? "team"}`}
      />
      <div
        className={cn(
          "flex min-w-0 flex-col gap-1 rounded-lg px-3 py-2 text-sm",
          mine ? "bg-accent" : "border border-border",
          open && "border-warning/70 bg-warning/5",
        )}
      >
        <p className="text-3xs text-muted-foreground">
          <span className="font-medium text-foreground">{entry.by}</span>
          {", "}
          {MESSAGE_KIND_LABEL[entry.kind] ?? entry.kind}, {time(entry.at)}
          <FullAutoAttribution entry={entry} />
        </p>
        {props.repliedTo ? (
          <p className="flex items-start gap-1 border-l-2 border-border pl-2 text-xs text-muted-foreground">
            <CornerDownRightIcon className="mt-0.5 size-3 shrink-0" />
            <span className="line-clamp-2">
              {props.repliedTo.by}: {props.repliedTo.text}
            </span>
          </p>
        ) : null}
        {entry.text ? (
          <p className="break-words whitespace-pre-wrap">
            {entry.text}
            <ShowSection entry={entry} onShow={props.onShow} />
          </p>
        ) : null}
        {entry.change ? (
          <p className="rounded border border-border bg-muted/40 px-2 py-1 text-xs whitespace-pre-wrap">
            {entry.change}
          </p>
        ) : null}
        <TaskFileList environmentId={props.environmentId} files={entry.files} />
        {entry.evidence ? (
          <p className="font-mono text-3xs break-all text-muted-foreground">
            evidence: {entry.evidence}
          </p>
        ) : null}
        {open && entry.kind === "question" && props.onReply ? (
          <div>
            <Button size="xs" variant="outline" onClick={() => props.onReply?.(entry)}>
              Answer
            </Button>
          </div>
        ) : null}
        {open && entry.kind === "proposal" && props.onSettle ? (
          <div className="flex gap-1">
            <Button
              size="xs"
              disabled={props.busy}
              onClick={() => props.onSettle?.(entry, true)}
              data-proposal-confirm
            >
              <CheckIcon />
              Confirm the change
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={props.busy}
              onClick={() => props.onSettle?.(entry, false)}
              data-proposal-decline
            >
              Decline
            </Button>
          </div>
        ) : null}
        {state && (mine || open) ? (
          <p className="text-3xs text-muted-foreground" data-message-state-label>
            {state}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Happening(props: {
  readonly entry: TimelineEntry;
  readonly onShow?: ((section: "acceptance" | "plan") => void) | undefined;
}) {
  const { entry } = props;
  const Icon = EVENT_ICON[entry.icon] ?? CircleDotIcon;
  return (
    <div
      data-timeline-entry={entry.id}
      data-event-kind={entry.kind}
      className={cn(
        "flex items-start gap-2 px-1 text-xs",
        entry.detail ? "text-muted-foreground/80" : "text-muted-foreground",
      )}
    >
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", EVENT_TONE[entry.icon])} />
      <p className="min-w-0 flex-1 break-words">
        <span className="font-medium text-foreground/80">{entry.by}</span> {entry.text}
        <FullAutoAttribution entry={entry} />
        <ShowSection entry={entry} onShow={props.onShow} />
        {entry.evidence ? (
          <span className="block font-mono text-3xs break-all">{entry.evidence}</span>
        ) : null}
      </p>
      <span className="shrink-0 text-3xs">{time(entry.at)}</span>
    </div>
  );
}

const replySequenceSchema = Schema.NullOr(Schema.Number);

/**
 * The engine's own log of the task, its messages and its steps, with its composer at the foot of
 * them. It lives in the Task item of the details. The composer is temporary: it goes once the
 * conversation carries change and answer natively.
 */
export function TaskEngineLog(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: TaskView;
  readonly onChanged: () => void;
  /** Shows a section of the task: the checklist or the plan a line of the log points at. */
  readonly onShow: (section: "acceptance" | "plan") => void;
}) {
  const { task } = props;
  const person = usePersonName();
  const showDetail = useBoardStore((state) => state.showDetail);
  const setShowDetail = useBoardStore((state) => state.setShowDetail);
  const act = useDeliveryAct(props.environmentId, "task proposal");
  const [replySeq, setReplySeq] = useLocalStorage(
    `t3code:task-reply-target:${JSON.stringify([props.environmentId, task.id])}`,
    null as number | null,
    replySequenceSchema,
  );
  const replyTo =
    task.timeline.find((entry) => entry.seq === replySeq && entry.kind === "question") ?? null;
  const setReplyTo = (entry: TimelineEntry | null) => setReplySeq(entry?.seq ?? null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const entries = task.timeline.filter((entry) => showDetail || !entry.detail);
  const bySeq = new Map(
    task.timeline
      .filter((entry) => entry.seq !== null)
      .map((entry) => [entry.seq as number, entry]),
  );

  const settle = async (entry: TimelineEntry, accept: boolean) => {
    setBusy(true);
    setProblem(null);
    const result = await act(`/api/tasks/${task.id}/proposals`, {
      proposal: entry.seq,
      accept,
      by: person,
    });
    setBusy(false);
    if (!result.ok) setProblem(result.why);
    props.onChanged();
  };

  const hidden = task.timeline.length - entries.length;
  return (
    <section className="flex min-w-0 flex-col gap-2" data-task-communications>
      <div className="flex justify-end">
        <button
          type="button"
          className="cursor-pointer text-2xs text-muted-foreground underline"
          aria-pressed={showDetail}
          onClick={() => setShowDetail(!showDetail)}
          data-task-detail-toggle
        >
          {showDetail
            ? "Hide the detail"
            : `Show every step${hidden > 0 ? ` (${hidden} more)` : ""}`}
        </button>
      </div>
      <div className="flex flex-col gap-2.5" data-task-timeline>
        {entries.map((entry) =>
          entry.source === "message" ? (
            <Message
              key={entry.id}
              environmentId={props.environmentId}
              entry={entry}
              repliedTo={entry.replyTo !== null ? (bySeq.get(entry.replyTo) ?? null) : null}
              busy={busy}
              onReply={(entry) => {
                setReplyTo(entry);
                setComposerExpanded(true);
              }}
              onSettle={(item, accept) => void settle(item, accept)}
              onShow={props.onShow}
            />
          ) : (
            <Happening key={entry.id} entry={entry} onShow={props.onShow} />
          ),
        )}
        {task.working ? (
          <p className="px-1 text-xs text-muted-foreground" data-task-working>
            The engine is moving this task on.
          </p>
        ) : null}
        {task.pendingFromPerson > 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            {task.pendingFromPerson} of your messages wait for the running step to end.
          </p>
        ) : null}
      </div>
      {problem ? <p className="text-sm text-warning">{problem}</p> : null}
      <TaskComposer
        expanded={composerExpanded}
        onExpandedChange={setComposerExpanded}
        environmentId={props.environmentId}
        task={task}
        replyTo={replyTo}
        onReplyTo={setReplyTo}
        onReplySent={(seq) => setReplySeq((current) => (current === seq ? null : current))}
        onSent={props.onChanged}
      />
    </section>
  );
}
