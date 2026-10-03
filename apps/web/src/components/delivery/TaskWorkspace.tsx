import type { EnvironmentId } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CirclePauseIcon,
  CirclePlayIcon,
  CircleXIcon,
  CornerDownRightIcon,
  EllipsisIcon,
  FileIcon,
  GitCommitHorizontalIcon,
  InfoIcon,
  ListChecksIcon,
  PaperclipIcon,
  PencilIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { useNavigate } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { usePrimarySettings } from "../../hooks/useSettings";
import {
  parseTask,
  seatSettingsToSend,
  TASK_PRIORITIES,
  targetLine,
  type TaskBrief,
  type TaskFile,
  type TaskPriority,
  repeatKeys,
  type TaskBriefing,
  type TaskWrapUp,
  type TaskView,
  type TimelineEntry,
  waitingWords,
} from "../../lib/delivery";
import {
  ageLabel,
  COMPOSER_EFFECT,
  COMPOSER_KIND_HELP,
  COMPOSER_KIND_LABEL,
  isSendKey,
  LANE_TITLE,
  messageStateLabel,
  moveIntent,
  PRIORITY_LABEL,
  tagsFromText,
  type ComposerKind,
} from "../../lib/deliveryBoard";
import { seatsChangedForTask, harnessLabel } from "../../lib/deliverySeats";
import { cn } from "../../lib/utils";
import {
  useBoardStore,
  useDeliveryAct,
  useDeliveryRead,
  useMinuteClock,
  usePersonName,
  useStaleReading,
  withSeatChoice,
} from "../../state/delivery";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MessageCopyButton } from "../chat/MessageCopyButton";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SeatSettingsPanel } from "./SeatSettingsPanel";
import { actionHelp, actionLabel, useTaskActions } from "./taskActions";
import { TaskEditor } from "./TaskEditor";
import {
  AttachButton,
  FilesInTransit,
  TaskFileList,
  useFileIntake,
  useTaskUploads,
} from "./taskFiles";
import { Age, Avatar, laneTone, PriorityPill, QaVotes, TagList, WaitingOn } from "./taskParts";

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

const time = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};

function Message(props: {
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
          open && "border-amber-500/70 bg-amber-500/5",
        )}
      >
        <p className="text-[10px] text-muted-foreground">
          <span className="font-medium text-foreground">{mine ? entry.by : entry.by}</span>
          {", "}
          {MESSAGE_KIND_LABEL[entry.kind] ?? entry.kind}, {time(entry.at)}
        </p>
        {props.repliedTo ? (
          <p className="flex items-start gap-1 border-l-2 border-border pl-2 text-xs text-muted-foreground">
            <CornerDownRightIcon className="mt-0.5 size-3 shrink-0" />
            <span className="line-clamp-2">
              {props.repliedTo.by}: {props.repliedTo.text}
            </span>
          </p>
        ) : null}
        {entry.text ? <p className="break-words whitespace-pre-wrap">{entry.text}</p> : null}
        {entry.change ? (
          <p className="rounded border border-border bg-muted/40 px-2 py-1 text-xs whitespace-pre-wrap">
            {entry.change}
          </p>
        ) : null}
        <TaskFileList environmentId={props.environmentId} files={entry.files} />
        {entry.evidence ? (
          <p className="font-mono text-[10px] break-all text-muted-foreground">
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
          <p className="text-[10px] text-muted-foreground" data-message-state-label>
            {state}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Happening(props: { readonly entry: TimelineEntry }) {
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
        {entry.evidence ? (
          <span className="block font-mono text-[10px] break-all">{entry.evidence}</span>
        ) : null}
      </p>
      <span className="shrink-0 text-[10px]">{time(entry.at)}</span>
    </div>
  );
}

// Expanded controls need both width and height: landscape phones still need room for history.
function MobileHelp(props: {
  readonly label: string;
  readonly children: React.ReactNode;
  /** Shown on every screen, not only a small one. */
  readonly always?: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            className={
              props.always ? undefined : "[@media(min-width:640px)_and_(min-height:600px)]:hidden"
            }
            aria-label={props.label}
          />
        }
      >
        <InfoIcon />
      </PopoverTrigger>
      <PopoverPopup side="top" className="max-w-[min(20rem,calc(100vw-2rem))] text-xs">
        {props.children}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Once the work is done or decided: what changed, what is left, who acts next. Folded until
 * opened; a draft to copy where it is wanted, posted nowhere.
 */
function WrapUp(props: { readonly wrapUp: TaskWrapUp }) {
  const { wrapUp } = props;
  const [open, setOpen] = useState(false);
  const rows: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["Changed", wrapUp.changed],
    ["Left", wrapUp.left],
    ["Next", wrapUp.next],
  ];
  return (
    <div className="shrink-0 border-b border-border px-3 py-2 text-xs" data-task-wrap-up>
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="mt-0.5 shrink-0 font-medium">Wrap-up</span>
          <span className="min-w-0 flex-1 text-muted-foreground">{wrapUp.next[0] ?? ""}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {open ? "Less" : "More"}
          </span>
        </button>
        <MessageCopyButton
          text={wrapUp.text}
          size="icon-xs"
          variant="ghost"
          label="Copy the wrap-up"
        />
      </div>
      {open ? (
        <dl className="mt-1.5 grid max-h-[40dvh] grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 overflow-y-auto overscroll-contain">
          {rows.map(([label, lines]) => (
            <Fragment key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd>
                <ul className="flex flex-col gap-0.5">
                  {lines.map((line, index) => (
                    <li key={repeatKeys(lines)[index]}>{line}</li>
                  ))}
                </ul>
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/**
 * What is needed of you, in plain words: the bottom line, then what the task is, what happened,
 * why it stopped, and what each choice would do. The steps themselves are in the bar below.
 */
function Briefing(props: { readonly brief: TaskBriefing }) {
  const { brief } = props;
  const now = useMinuteClock();
  const since = brief.since && !Number.isNaN(Date.parse(brief.since)) ? brief.since : null;
  // Lines and actions come from the engine and can repeat: each key says which repeat it is.
  const happenedKeys = repeatKeys(brief.happened);
  const optionKeys = repeatKeys(brief.options.map((option) => option.action));
  const [open, setOpen] = useState(true);
  return (
    // The whole panel, headline too, is held to part of the screen and scrolls within, so the
    // history and the composer keep their room on a phone.
    <div
      className="max-h-[40dvh] shrink-0 overflow-y-auto overscroll-contain border-b border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs"
      data-task-brief
    >
      <button
        type="button"
        className="flex w-full cursor-pointer items-start gap-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="mt-0.5 shrink-0 font-medium text-amber-700 dark:text-amber-300">
          Needs you
        </span>
        <span className="min-w-0 flex-1 font-medium">{brief.headline}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{open ? "Less" : "More"}</span>
      </button>
      {open ? (
        <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          {brief.what ? (
            <>
              <dt className="text-muted-foreground">What</dt>
              <dd>{brief.what}</dd>
            </>
          ) : null}
          {brief.happened.length > 0 ? (
            <>
              <dt className="text-muted-foreground">Happened</dt>
              <dd>
                <ul className="flex flex-col gap-0.5">
                  {brief.happened.map((line, index) => (
                    // A line the engine indents belongs to the one above it.
                    <li
                      key={happenedKeys[index]}
                      className={line.startsWith("  ") ? "pl-3 text-muted-foreground" : undefined}
                    >
                      {line.trim()}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
          {brief.why ? (
            <>
              <dt className="text-muted-foreground">Why</dt>
              <dd>{brief.why}</dd>
            </>
          ) : null}
          {brief.options.length > 0 || brief.reply ? (
            <>
              <dt className="text-muted-foreground">Choices</dt>
              <dd>
                <ul className="flex flex-col gap-0.5">
                  {brief.options.map((option, index) => (
                    <li key={optionKeys[index]}>
                      <span className="font-medium">{option.label}</span>
                      {option.recommended ? (
                        <span className="ml-1 rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-300">
                          suggested
                        </span>
                      ) : null}
                      <span className="text-muted-foreground"> {option.does}</span>
                    </li>
                  ))}
                  {brief.reply ? <li className="text-muted-foreground">{brief.reply}</li> : null}
                </ul>
              </dd>
            </>
          ) : null}
          {brief.where || since ? (
            <>
              <dt className="text-muted-foreground">Where</dt>
              <dd className="text-muted-foreground">
                {brief.where}
                {brief.where && since ? ", " : ""}
                {since ? (
                  <>
                    waiting since{" "}
                    <time dateTime={since}>
                      {new Date(since).toLocaleString([], {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </time>{" "}
                    (<Age at={since} now={now} label="Waiting since" />)
                  </>
                ) : null}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

function Composer(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: TaskView;
  readonly replyTo: TimelineEntry | null;
  readonly onReplyTo: (entry: TimelineEntry | null) => void;
  readonly onSent: () => void;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
}) {
  const { task } = props;
  const person = usePersonName();
  const sendShortcut = usePrimarySettings((settings) => settings.sendShortcut);
  const act = useDeliveryAct(props.environmentId, "task message");
  const uploads = useTaskUploads(props.environmentId, person);
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<ComposerKind>("message");
  const [files, setFiles] = useState<ReadonlyArray<TaskFile>>([]);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);

  const waits = task.questions.at(-1) ?? null;
  // Answering is chosen by pressing Answer on the question, or here while a question waits.
  const replying =
    props.replyTo ??
    (chosen === "answer" && waits ? { seq: waits.seq, by: waits.by, text: waits.text } : null);
  const kind: ComposerKind = replying ? "answer" : chosen === "answer" ? "message" : chosen;
  // A chat has nothing that is asked of the team to change: what is written is the conversation.
  const chat = task.workflow === "chat";
  const kinds: ReadonlyArray<ComposerKind> = [
    ...(waits ? (["answer"] as const) : []),
    ...(chat
      ? (["message", "note", "status"] as const)
      : (["message", "note", "change", "status"] as const)),
  ];
  const help = (item: ComposerKind) =>
    chat && item === "message"
      ? "Read by the seat that leads the chat, which answers, or brings in the seats it concerns. Each answers under its own name."
      : COMPOSER_KIND_HELP[item];
  const closed = task.state === "rejected" || task.state === "closed";

  const attach = async (picked: File[]) => {
    const sent = await Promise.all(picked.map((file) => uploads.send(task.id, file)));
    setFiles((current) => [...current, ...sent.filter((file): file is TaskFile => file !== null)]);
  };
  const intake = useFileIntake((picked) => void attach(picked));
  const uploading = uploads.transit.some((item) => item.problem === null);
  const canSend = !busy && !uploading && !closed && (text.trim().length > 0 || files.length > 0);

  const send = async () => {
    if (!canSend || sending.current) return;
    sending.current = true;
    setBusy(true);
    setProblem(null);
    const result = await act(`/api/tasks/${task.id}/messages`, {
      text: text.trim(),
      kind,
      ...(replying?.seq ? { replyTo: replying.seq } : {}),
      files: files.map((file) => file.id),
      by: person,
    });
    sending.current = false;
    setBusy(false);
    props.onSent();
    if (!result.ok) {
      setProblem(result.why);
      return;
    }
    setText("");
    setFiles([]);
    setChosen("message");
    props.onReplyTo(null);
  };
  const effect = COMPOSER_EFFECT[kind];

  return (
    <div
      className={cn(
        "flex min-h-0 shrink-0 flex-col border-t border-border p-2 [@media(min-width:640px)_and_(min-height:600px)]:p-3 max-h-[45%] [@media(min-width:640px)_and_(min-height:600px)]:max-h-none",
        intake.over && "outline-2 -outline-offset-4 outline-ring outline-dashed",
      )}
      data-task-composer
      {...intake.handlers}
    >
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0 justify-start [@media(min-width:640px)_and_(min-height:600px)]:hidden"
        aria-expanded={props.expanded}
        aria-controls={`composer-${task.id}`}
        onClick={() => props.onExpandedChange(!props.expanded)}
        data-task-composer-toggle
      >
        <PencilIcon />
        {props.expanded
          ? "Hide message"
          : text.trim() || files.length
            ? "Continue draft"
            : "Write to the team"}
      </Button>
      <div
        id={`composer-${task.id}`}
        className={cn(
          "min-h-0 flex-col gap-2 overflow-y-auto [@media(min-width:640px)_and_(min-height:600px)]:flex",
          props.expanded ? "flex" : "hidden",
        )}
      >
        {problem ? (
          <p className="text-sm text-warning" data-delivery-problem>
            {problem}
          </p>
        ) : null}
        {replying ? (
          <p
            className="flex items-start gap-1 rounded border border-amber-500/60 bg-amber-500/5 px-2 py-1 text-xs"
            data-task-composer-reply
          >
            <CornerDownRightIcon className="mt-0.5 size-3 shrink-0" />
            {/* Two lines are enough to say which question: the whole of it is in the history above. */}
            <span className="line-clamp-2 min-w-0 flex-1">
              Answering {replying.by}:{" "}
              <span className="text-muted-foreground">{replying.text}</span>
            </span>
            <button
              type="button"
              aria-label="Do not answer this question"
              className="cursor-pointer"
              onClick={() => props.onReplyTo(null)}
            >
              <XIcon className="size-3" />
            </button>
          </p>
        ) : waits ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            A question of {waits.by} waits for you. Choose Answer a question below, or press Answer
            on it.
          </p>
        ) : null}
        <Textarea
          aria-label="Message on the task"
          placeholder={
            closed
              ? "This is closed. What was said is kept."
              : kind === "answer"
                ? "Your answer"
                : kind === "status"
                  ? "What do you want to know? The record is read out."
                  : kind === "change"
                    ? "What is to change in what is asked"
                    : kind === "note"
                      ? "A note for the record"
                      : "Write to the team. Paste or drop files here."
          }
          disabled={closed}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (isSendKey(event.nativeEvent, sendShortcut, text)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <TaskFileList
          environmentId={props.environmentId}
          files={files}
          compact
          onRemove={(file) => setFiles((current) => current.filter((item) => item.id !== file.id))}
        />
        <FilesInTransit transit={uploads.transit} onDismiss={uploads.dismiss} />
        <div className="flex items-center gap-1">
          <AttachButton
            label="Attach files"
            disabled={closed}
            onFiles={(picked) => void attach(picked)}
          >
            <PaperclipIcon />
          </AttachButton>
          {props.replyTo ? (
            <Badge size="sm" variant="outline">
              {COMPOSER_KIND_LABEL.answer}
            </Badge>
          ) : (
            <Select value={kind} onValueChange={(value) => setChosen(value as ComposerKind)}>
              <SelectTrigger
                aria-label="What this message is"
                size="compact"
                variant="ghost"
                className="w-auto min-w-0"
              >
                <SelectValue>{COMPOSER_KIND_LABEL[kind]}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {kinds.map((item) => (
                  <SelectItem key={item} value={item}>
                    <span className="flex max-w-96 flex-col">
                      <span>{COMPOSER_KIND_LABEL[item]}</span>
                      <span className="text-xs text-muted-foreground">{help(item)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          <span className="min-w-0 flex-1" />
          <MobileHelp label="About this message" always>
            <p>
              {effect.moves ? "Moves the work:" : "Changes nothing:"} {effect.label}
            </p>
            <p className="mt-2 text-muted-foreground">{help(kind)}</p>
          </MobileHelp>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  className="ml-auto rounded-full"
                  aria-label={`Send: ${COMPOSER_KIND_LABEL[kind]}`}
                  disabled={!canSend}
                  onClick={() => void send()}
                  data-task-send
                />
              }
            >
              <SendIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {uploading ? "Files are still on their way." : `Send: ${COMPOSER_KIND_LABEL[kind]}`}
            </TooltipPopup>
          </Tooltip>
        </div>
        {/* Said only when sending moves the work; the rest is behind the info icon. */}
        {effect.moves ? (
          <p
            className="hidden items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-300 [@media(min-width:640px)_and_(min-height:600px)]:flex"
            data-task-composer-effect="moves"
          >
            <span className="shrink-0 font-medium">Moves the work:</span>
            <span className="min-w-0">{effect.label}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The decisions a person makes on the task: approve what was tested, send it back with a
 * reason, start or submit it. Kept apart from the composer, and below every tab, so that
 * what is written is never taken for a decision and the buttons are in reach on a phone.
 */
function DecisionBar(props: {
  readonly task: TaskView;
  readonly actions: ReadonlyArray<string>;
  readonly busy: boolean;
  readonly onAction: (action: string) => void;
}) {
  if (props.actions.length === 0) return null;
  const deciding = props.actions.some((action) => action === "approve" || action === "reject");
  return (
    <section
      className="flex shrink-0 flex-col gap-1 border-t border-border bg-muted/30 px-3 py-1 pb-[calc(env(safe-area-inset-bottom)+0.25rem)] [@media(min-width:640px)_and_(min-height:600px)]:gap-2 [@media(min-width:640px)_and_(min-height:600px)]:py-2"
      aria-label="Your decision"
      data-task-decisions
    >
      <p className="hidden text-xs font-medium [@media(min-width:640px)_and_(min-height:600px)]:block">
        {deciding ? "Your decision" : "What you can do next"}
        {deciding ? (
          <span className="font-normal text-muted-foreground">
            {" "}
            Messages never count as a decision.
          </span>
        ) : null}
      </p>
      <div className="flex items-center gap-2 [@media(min-width:640px)_and_(min-height:600px)]:flex-wrap">
        {props.actions.map((action) => (
          <div
            key={action}
            className="flex min-w-0 flex-1 flex-col gap-0.5 [@media(min-width:640px)_and_(min-height:600px)]:max-w-80 [@media(min-width:640px)_and_(min-height:600px)]:flex-none"
          >
            <Button
              size="sm"
              variant={action === "reject" ? "outline" : "default"}
              className="w-full justify-center"
              disabled={props.busy}
              onClick={() => props.onAction(action)}
              data-task-action={action}
            >
              <span className="truncate">{actionLabel(action, props.task.card)}</span>
            </Button>
            <span className="hidden text-[10px] text-muted-foreground [@media(min-width:640px)_and_(min-height:600px)]:block">
              {actionHelp(action, props.task.card)}
            </span>
          </div>
        ))}
        <MobileHelp label="About your decision">
          {deciding ? <p>Messages never count as a decision.</p> : null}
          {props.actions.map((item) => (
            <p key={item} className="mt-2">
              <strong>{actionLabel(item, props.task.card)}: </strong>
              {actionHelp(item, props.task.card)}
            </p>
          ))}
        </MobileHelp>
      </div>
    </section>
  );
}

function Communications(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: TaskView;
  readonly onChanged: () => void;
}) {
  const { task } = props;
  const person = usePersonName();
  const showDetail = useBoardStore((state) => state.showDetail);
  const setShowDetail = useBoardStore((state) => state.setShowDetail);
  const act = useDeliveryAct(props.environmentId, "task proposal");
  const [replyTo, setReplyTo] = useState<TimelineEntry | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const entries = useMemo(
    () => task.timeline.filter((entry) => showDetail || !entry.detail),
    [showDetail, task.timeline],
  );
  const bySeq = useMemo(
    () =>
      new Map(
        task.timeline
          .filter((entry) => entry.seq !== null)
          .map((entry) => [entry.seq as number, entry]),
      ),
    [task.timeline],
  );
  // A question that was answered meanwhile is not answered twice.
  const replying =
    replyTo && task.questions.some((question) => question.seq === replyTo.seq) ? replyTo : null;

  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useEffect(() => {
    const node = scroller.current;
    if (node && atEnd.current) node.scrollTop = node.scrollHeight;
  }, [entries.length]);

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
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" data-task-communications>
      {props.task.brief && props.task.card.waitingOn === "person" ? (
        <Briefing brief={props.task.brief} />
      ) : null}
      {props.task.wrapUp ? <WrapUp wrapUp={props.task.wrapUp} /> : null}
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <h2 className="text-xs font-medium">History and messages</h2>
        <button
          type="button"
          className="cursor-pointer text-[11px] text-muted-foreground underline"
          aria-pressed={showDetail}
          onClick={() => setShowDetail(!showDetail)}
          data-task-detail-toggle
        >
          {showDetail
            ? "Hide the detail"
            : `Show every step${hidden > 0 ? ` (${hidden} more)` : ""}`}
        </button>
      </div>
      <div
        ref={scroller}
        className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3"
        onScroll={(event) => {
          const node = event.currentTarget;
          atEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
        data-task-timeline
      >
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
            />
          ) : (
            <Happening key={entry.id} entry={entry} />
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
      {problem ? <p className="px-3 pb-1 text-sm text-warning">{problem}</p> : null}
      <Composer
        expanded={composerExpanded}
        onExpandedChange={setComposerExpanded}
        environmentId={props.environmentId}
        task={task}
        replyTo={replying}
        onReplyTo={setReplyTo}
        onSent={props.onChanged}
      />
    </section>
  );
}

function Listed(props: { readonly title: string; readonly items: ReadonlyArray<string> }) {
  if (props.items.length === 0) return null;
  return (
    <section>
      <h3 className="pb-1 text-xs font-medium text-muted-foreground">{props.title}</h3>
      <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm">
        {props.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function Briefs(props: {
  readonly title: string;
  readonly tasks: ReadonlyArray<
    TaskBrief & { readonly kind?: string; readonly direction?: string }
  >;
  readonly onOpen: (id: string) => void;
}) {
  if (props.tasks.length === 0) return null;
  return (
    <section>
      <h3 className="pb-1 text-xs font-medium text-muted-foreground">{props.title}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {props.tasks.map((item) => (
          <li key={`${item.id}:${item.kind ?? ""}:${item.direction ?? ""}`}>
            <button
              type="button"
              onClick={() => props.onOpen(item.id)}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-1 text-left hover:bg-accent"
            >
              <span className={cn("size-2 shrink-0 rounded-full", laneTone(item.lane).bar)} />
              <span className="font-mono text-[10px] text-muted-foreground">#{item.number}</span>
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {item.kind === "depends-on"
                  ? item.direction === "out"
                    ? "this waits for it"
                    : "it waits for this"
                  : ""}{" "}
                {LANE_TITLE[item.lane ?? ""] ?? item.state}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Details(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: TaskView;
  readonly onOpenTask: (id: string) => void;
}) {
  const { task } = props;
  const [showRevisions, setShowRevisions] = useState(false);
  return (
    <section className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto p-4" data-task-details>
      <section>
        <h3 className="pb-1 text-xs font-medium text-muted-foreground">
          What is asked, revision {task.revision}
        </h3>
        <p className="text-sm break-words whitespace-pre-wrap">{task.body}</p>
      </section>
      {task.plan ? (
        <section className="flex flex-col gap-2 rounded-md border border-border p-2" data-task-plan>
          <h3 className="text-xs font-medium">
            The plan{task.plan.agreed ? ", agreed and being delivered" : ", for you to read"}
          </h3>
          <p className="text-sm break-words whitespace-pre-wrap">{task.plan.approach}</p>
          <Listed title="Steps" items={task.plan.steps} />
          <Listed title="Checks" items={task.plan.checks} />
          <Listed title="What it does not cover" items={task.plan.limits} />
          {task.plan.comments.map((comment) => (
            <p key={comment.seat} className="text-xs text-muted-foreground">
              {comment.seat}: {comment.stance}
              {comment.points.length > 0 ? `. ${comment.points.join(" ")}` : ""}
            </p>
          ))}
          <p className="font-mono text-[10px] break-all text-muted-foreground">{task.plan.file}</p>
        </section>
      ) : null}
      {task.review ? (
        <section
          className="flex flex-col gap-2 rounded-md border border-border p-2"
          data-task-review
        >
          <h3 className="text-xs font-medium">What the review found</h3>
          {task.review.seats.map((seat) => (
            <div
              key={seat.seat}
              className="flex flex-col gap-1 text-sm"
              data-review-seat={seat.seat}
            >
              <p className="text-xs font-medium">
                {seat.seat} on {harnessLabel(seat.harness)}
              </p>
              <p className="break-words whitespace-pre-wrap">{seat.summary}</p>
              {seat.findings.length === 0 ? (
                <p className="text-xs text-muted-foreground">No findings.</p>
              ) : (
                <ul className="flex list-disc flex-col gap-0.5 pl-5 text-xs">
                  {seat.findings.map((finding) => (
                    <li key={`${finding.title}:${finding.where}`}>
                      {finding.blocking ? <span className="text-warning">Blocking. </span> : null}
                      {finding.title}{" "}
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {finding.where}
                      </span>
                      <span className="block text-muted-foreground">{finding.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {task.review.missing.length > 0 ? (
            <p className="text-xs text-warning">No answer from {task.review.missing.join(", ")}.</p>
          ) : null}
          <p className="font-mono text-[10px] break-all text-muted-foreground">
            {task.review.file}
          </p>
        </section>
      ) : null}
      <Listed title="Requirements" items={task.requirements} />
      <Listed title="Acceptance criteria" items={task.acceptance} />
      {task.files.length > 0 ? (
        <section>
          <h3 className="pb-1 text-xs font-medium text-muted-foreground">
            Files ({task.files.length})
          </h3>
          <TaskFileList environmentId={props.environmentId} files={task.files} />
        </section>
      ) : null}
      {task.parent ? (
        <Briefs title="Part of" tasks={[task.parent]} onOpen={props.onOpenTask} />
      ) : null}
      <Briefs
        title={`Parts (${task.card.partsDelivered} of ${task.card.parts.length} delivered)`}
        tasks={task.card.parts}
        onOpen={props.onOpenTask}
      />
      <Briefs title="Related" tasks={task.links} onOpen={props.onOpenTask} />
      <Briefs title="Filed from QA findings" tasks={task.followUps} onOpen={props.onOpenTask} />
      {task.revisions.length > 1 ? (
        <section>
          <button
            type="button"
            className="cursor-pointer pb-1 text-xs font-medium text-muted-foreground underline"
            aria-expanded={showRevisions}
            onClick={() => setShowRevisions((current) => !current)}
          >
            {showRevisions ? "Hide" : "Show"} the {task.revisions.length} revisions
          </button>
          {showRevisions ? (
            <ul className="flex flex-col gap-2">
              {task.revisions.toReversed().map((revision) => (
                <li key={revision.revision} className="rounded border border-border p-2 text-xs">
                  <p className="font-mono text-[10px] text-muted-foreground">
                    r{revision.revision}, {time(revision.created)}
                    {revision.notes ? `, ${revision.notes}` : ""}
                  </p>
                  <p className="break-words whitespace-pre-wrap">{revision.body}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function Row(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{props.label}</span>
      <span className="min-w-0 text-right break-words">{props.children}</span>
    </div>
  );
}

const ACTIVITY_VARIANT: Record<string, "success" | "info" | "warning" | "secondary" | "error"> = {
  active: "info",
  queued: "warning",
  completed: "success",
  waiting: "secondary",
  unavailable: "error",
};

function Info(props: {
  readonly environmentId: EnvironmentId | null;
  readonly from: "Board" | "Orchestrator";
  readonly task: TaskView;
  readonly onChanged: () => void;
  /** Takes the task to a column, by the step that leads there; see moveIntent. */
  readonly onMoveTo: (lane: string) => void;
  /** A request is out: nothing more is sent until it returns. */
  readonly busy: boolean;
}) {
  const { task } = props;
  const { card } = task;
  const person = usePersonName();
  const name = useBoardStore((state) => state.person);
  const setPerson = useBoardStore((state) => state.setPerson);
  const now = useMinuteClock();
  const act = useDeliveryAct(props.environmentId, "task edit");
  const [tags, setTags] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);
  const closed = ["approved", "rejected", "closed"].includes(task.state);
  const flow = task.flows.find((item) => item.id === task.workflow) ?? null;
  const navigate = useNavigate();
  // The boards of the person's own, to move the task between.
  const boardsRead = useDeliveryRead(props.environmentId, "/api/boards");
  const boards = useMemo(
    () =>
      (Array.isArray(boardsRead.body) ? boardsRead.body : []).flatMap((item: unknown) =>
        item && typeof item === "object" && "id" in item && "title" in item
          ? [{ id: String(item.id), title: String(item.title) }]
          : [],
      ),
    [boardsRead.body],
  );
  // What is set for the task, which the switches change.
  const set = Object.fromEntries(task.settings.map((item) => [item.seat, item.set]));
  // The seat choices last sent. Until a read of the task shows it changed since (its last
  // change is later), a second switch builds on the first, instead of on a read from before
  // it, a poll included, which would undo it.
  const sentSeats = useRef<{ readonly updated: string; readonly set: typeof set } | null>(null);
  const switchSeat = async (seat: string, choice: Record<string, string>) => {
    setProblems([]);
    const pending = sentSeats.current && task.updated <= sentSeats.current.updated;
    const base = pending && sentSeats.current ? sentSeats.current.set : set;
    const next = withSeatChoice(base, seat, choice);
    sentSeats.current = {
      updated: pending && sentSeats.current ? sentSeats.current.updated : task.updated,
      set: next,
    };
    const result = await act(`/api/tasks/${task.id}/edit`, {
      seats: seatSettingsToSend(task.settings, next),
      by: person,
    });
    if (!result.ok) setProblems(result.problems.length > 0 ? result.problems : [result.why]);
    props.onChanged();
  };

  const edit = async (patch: Record<string, unknown>) => {
    setProblem(null);
    const result = await act(`/api/tasks/${task.id}/edit`, { ...patch, by: person });
    if (!result.ok) setProblem(result.why);
    props.onChanged();
  };

  return (
    <aside
      className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto p-4"
      data-task-info
      aria-label="About this task"
    >
      <section className="flex flex-col gap-1.5">
        <Row label="Stands in">
          {task.isDraft || !task.lane ? (
            <span className="inline-flex items-center gap-1.5" data-task-lane={task.lane ?? ""}>
              <span className={cn("size-2 rounded-full", laneTone(task.lane).bar)} />
              {LANE_TITLE[task.lane ?? ""] ?? task.state}
            </span>
          ) : (
            <Select
              value={task.lane}
              onValueChange={(value) =>
                value && value !== task.lane && props.onMoveTo(String(value))
              }
            >
              <SelectTrigger
                aria-label="Column"
                size="compact"
                variant="ghost"
                className="w-auto min-w-0"
                disabled={props.busy}
                data-task-lane={task.lane}
              >
                <SelectValue>
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn("size-2 rounded-full", laneTone(task.lane).bar)} />
                    {LANE_TITLE[task.lane] ?? task.state}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {Object.entries(LANE_TITLE)
                  .filter(([lane]) => lane !== "draft")
                  .map(([lane, title]) => {
                    const intent = moveIntent(card, lane);
                    // What choosing it does, or why it cannot be chosen, is said to every reader.
                    const said =
                      intent.kind === "refused"
                        ? intent.why
                        : intent.kind === "action"
                          ? actionLabel(intent.action, card)
                          : lane === task.lane
                            ? "Here now"
                            : intent.label;
                    return (
                      <SelectItem
                        key={lane}
                        value={lane}
                        aria-label={`${title}: ${said}`}
                        data-move={intent.kind}
                      >
                        <span
                          className={cn(
                            "inline-flex items-center gap-1.5",
                            intent.kind === "refused" && "text-muted-foreground",
                          )}
                        >
                          <span className={cn("size-2 rounded-full", laneTone(lane).bar)} />
                          {title}
                          {lane !== task.lane ? (
                            <span className="text-[10px] text-muted-foreground">
                              {intent.kind === "refused"
                                ? "not from here, choose to see why"
                                : said}
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    );
                  })}
              </SelectPopup>
            </Select>
          )}
        </Row>
        {card.set === "qualification" ? (
          <Row label="Kept as">
            <span data-task-set="qualification">the qualification's evidence, not pilot work</span>
          </Row>
        ) : (
          <Row label="Board">
            <Select
              value={card.set ?? NO_BOARD}
              onValueChange={(value) =>
                void act(`/api/tasks/${task.id}/board`, {
                  board: value === NO_BOARD ? null : String(value),
                  by: person,
                }).then((result) => {
                  if (!result.ok) setProblem(result.why);
                  props.onChanged();
                })
              }
            >
              <SelectTrigger
                aria-label="Board"
                size="compact"
                variant="ghost"
                className="w-auto min-w-0"
                data-task-board={card.set ?? ""}
              >
                <SelectValue>
                  {boards.find((item) => item.id === card.set)?.title ??
                    (card.set ? card.set : "Not on a board")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value={NO_BOARD}>Not on a board</SelectItem>
                {boards.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Row>
        )}
        <Row label="Now">
          <WaitingOn card={card} />
        </Row>
        {card.blocker ? (
          <p
            className={cn(
              "rounded border px-2 py-1 text-xs",
              card.waitingOn === "person"
                ? "border-amber-500/60 bg-amber-500/5"
                : "border-border text-muted-foreground",
            )}
            data-task-blocker
          >
            {card.blocker}
          </p>
        ) : null}
        {card.workers.map((worker) => (
          <Row
            key={`${worker.seat}:${worker.stage}`}
            label={worker.waiting ? "Waiting" : "Working"}
          >
            {worker.seat} on {harnessLabel(worker.harness)}, {worker.stage}
            {worker.waiting ? `, ${waitingWords(worker.waiting)}` : ""}
            {worker.specialist ? ` as ${worker.specialist}` : ""}{" "}
            <Age at={worker.since} now={now} label="Since" />
          </Row>
        ))}
        {card.qa && card.qa.votes.length > 0 ? (
          <Row label="QA">
            <QaVotes qa={card.qa} />
          </Row>
        ) : null}
        {card.findings.all > 0 ? (
          <Row label="Findings">
            {card.findings.open} open of {card.findings.all}
          </Row>
        ) : null}
        {card.approvals.map((approval) => (
          <Row key={`${approval.actor}:${approval.decision}:${approval.stands}`} label="Decision">
            <span
              className="flex flex-col items-end"
              data-task-approval-verified={approval.verifiedAt ?? ""}
            >
              <span>
                {approval.decision} by {approval.actor},{" "}
                {approval.stands ? "stands" : "no longer stands"}
              </span>
              {approval.verifiedAt ? (
                <span className="text-[10px] text-muted-foreground">
                  checked{" "}
                  {ageLabel(approval.verifiedAt, now) === "now" ||
                  !ageLabel(approval.verifiedAt, now)
                    ? "just now"
                    : `${ageLabel(approval.verifiedAt, now)} ago`}
                  ; proved again before anything is published
                </span>
              ) : null}
            </span>
          </Row>
        ))}
      </section>

      <section className="flex flex-col gap-1.5">
        <Row label="Priority">
          {closed ? (
            <PriorityPill priority={task.priority} by={task.priorityBy} />
          ) : (
            <Select
              value={task.priority}
              onValueChange={(value) => void edit({ priority: value as TaskPriority })}
            >
              <SelectTrigger
                aria-label="Priority"
                size="compact"
                variant="ghost"
                className="ml-auto w-auto min-w-0"
              >
                <SelectValue>
                  <PriorityPill priority={task.priority} />
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {TASK_PRIORITIES.map((priority) => (
                  <SelectItem key={priority} value={priority}>
                    {PRIORITY_LABEL[priority]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
        </Row>
        {/* Where its work is done. A task keeps it; moving it to another board does not change it. */}
        <Row label="Repository">
          <span
            className="flex min-w-0 flex-col"
            data-task-target={task.target?.ok ? "ok" : "none"}
          >
            <span className={task.target?.ok ? "" : "text-warning"}>{targetLine(task.target)}</span>
            {task.target?.ok && task.target.path ? (
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {task.target.path}
              </span>
            ) : null}
          </span>
        </Row>
        <Row label="Team">{task.team}</Row>
        <Row label="Flow">
          <span data-task-flow={task.workflow}>{flow?.title ?? task.workflow}</span>
        </Row>
        <Row label="Owner">{task.owner || "nobody"}</Row>
        <Row label="Tags">
          {tags === null ? (
            <span className="inline-flex flex-wrap items-center justify-end gap-1">
              <TagList tags={task.tags} />
              {closed ? null : (
                <button
                  type="button"
                  aria-label="Change the tags"
                  className="cursor-pointer text-muted-foreground hover:text-foreground"
                  onClick={() => setTags(task.tags.join(", "))}
                >
                  <PencilIcon className="size-3" />
                </button>
              )}
            </span>
          ) : (
            <Input
              aria-label="Tags"
              className="h-7 w-44 text-xs"
              autoFocus
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              onBlur={() => {
                void edit({ tags: tagsFromText(tags) });
                setTags(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setTags(null);
              }}
            />
          )}
        </Row>
        {task.deadline ? <Row label="Wanted by">{task.deadline.slice(0, 10)}</Row> : null}
        <Row label="Created">{time(task.created)}</Row>
        {task.submitted ? <Row label="Submitted">{time(task.submitted)}</Row> : null}
        <Row label="Last changed">{time(task.updated)}</Row>
        <Row label="Id">
          <span className="font-mono text-[10px]">{task.id}</span>
        </Row>
        {problem ? <p className="text-xs text-warning">{problem}</p> : null}
      </section>

      {card.run ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Run</h3>
          <Row label="Run">
            <span className="font-mono text-[10px]">{card.run.id}</span>
          </Row>
          <Row label="State">
            {card.run.state} at {card.run.stage}
          </Row>
          {card.run.candidate ? (
            <Row label="Candidate">
              <span className="font-mono text-[10px]">{card.run.candidate.slice(0, 12)}</span>
            </Row>
          ) : null}
          <Row label="Setup">
            <span className="font-mono text-[10px]">{card.run.configuration}</span>
          </Row>
          {task.council?.evidence ? (
            <Row label="Evidence">
              <span className="font-mono text-[10px] break-all">{task.council.evidence}</span>
            </Row>
          ) : null}
          {task.children.length > 1 ? (
            <Row label="Runs">{task.children.length} for this task</Row>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-1.5" data-task-related>
        <h3 className="text-xs font-medium text-muted-foreground">Where else it shows</h3>
        <p className="text-[11px] text-muted-foreground">
          What is said on this task is its conversation with the team. A thread in the chat list is
          a conversation of its own; it becomes a task only when you create one from it.
        </p>
        {task.source ? (
          <Row label="Made from">
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              data-task-related-source
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: {
                    environmentId: task.source!.environmentId,
                    threadId: task.source!.threadId,
                  },
                })
              }
            >
              the conversation it came from
            </button>
          </Row>
        ) : null}
        {card.run ? (
          <Row label="Run">
            <span className="font-mono text-[10px]" data-task-related-run>
              {card.run.id}
              {card.run.candidate ? ` · commit ${card.run.candidate.slice(0, 10)}` : ""}
            </span>
          </Row>
        ) : null}
        {card.waitingOn ? (
          <Row label="Waiting on you">
            <span data-task-related-waiting>yes: {card.waitingOn}</span>
          </Row>
        ) : null}
        <PublicationRows task={task} />
      </section>

      {closed ? null : (
        <section className="flex flex-col gap-1.5" data-task-seats>
          <h3 className="text-xs font-medium text-muted-foreground">Seats that take part</h3>
          <SeatSettingsPanel
            environmentId={props.environmentId}
            settings={task.settings.map((item) => ({ ...item, now: item.effective }))}
            chosen={{}}
            taking={flow?.seats}
            switchesOnly
            onChange={(seat, choice) =>
              void switchSeat(seat, {
                ...set[seat],
                active: choice.active === "" || choice.active === undefined ? "" : choice.active,
              })
            }
          />
          {seatsChangedForTask(task.settings).length > 0 ? (
            <div
              className="rounded border border-border bg-muted/40 px-2 py-1.5 text-[11px]"
              data-task-seats-changed
            >
              <p className="font-medium">
                Changed for this task only. The team's own setting is as it was.
              </p>
              <ul className="list-disc pl-4 text-muted-foreground">
                {seatsChangedForTask(task.settings).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {problems.length > 0 ? (
            <ul className="list-disc pl-5 text-[11px] text-warning" data-delivery-problem>
              {problems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            {task.workflow === "chat"
              ? "A change counts from the next message on."
              : "A run keeps the seats it started with. A change counts for the next run. A seat that is working when it is switched off is asked to stop."}
          </p>
        </section>
      )}

      <section className="flex flex-col gap-1.5" data-task-roster>
        <h3 className="text-xs font-medium text-muted-foreground">
          Team {task.team}
          {task.defaults > 0 ? `, defaults r${task.defaults}` : ""}
        </h3>
        {task.council ? (
          task.council.seats.map((seat) => (
            <div key={seat.seat} className="flex items-start justify-between gap-2 text-xs">
              <span className="min-w-0">
                {seat.seat}
                <span className="block text-[10px] text-muted-foreground">
                  {harnessLabel(seat.harness)}, {seat.requestedModel ?? "its own model"}
                  {seat.reasoning ? `, ${seat.reasoning}` : ""}
                  {seat.access && seat.access !== "full" ? `, ${seat.access}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <Badge size="sm" variant={ACTIVITY_VARIANT[seat.activity] ?? "secondary"}>
                  {seat.activity}
                </Badge>
                <span className="block text-[10px] text-muted-foreground">
                  {seat.blockedBy
                    ? `waits for ${seat.blockedBy}`
                    : seat.verdict
                      ? `verdict ${seat.verdict}`
                      : (seat.stage ?? "")}
                </span>
              </span>
            </div>
          ))
        ) : (
          <SeatSettingsPanel
            environmentId={props.environmentId}
            settings={task.settings}
            chosen={{}}
          />
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium text-muted-foreground">Your name</h3>
        <Input
          aria-label="Your name"
          placeholder="Written on what you do here"
          className="h-7 text-xs"
          value={name}
          onChange={(event) => setPerson(event.target.value)}
        />
      </section>
    </aside>
  );
}

/**
 * What became of the approved change, told apart: awaiting your decision, approved and not
 * published, a pull request open, merged, or a failed attempt with its reason. Approval is never
 * shown as publication, nor publication as a merge.
 */
function PublicationRows(props: { readonly task: TaskView }) {
  const { task } = props;
  const publication = task.publications.at(-1) ?? null;
  const url = publication?.pullRequest?.url ?? null;
  const external = url !== null && /^https?:\/\//.test(url);
  const said =
    publication === null
      ? task.state === "approved"
        ? task.publishing.enabled
          ? `Approved, not published yet${task.publishing.blockers.length ? `: ${task.publishing.blockers.join("; ")}` : "."}`
          : `Approved, not published. ${task.publishing.why ?? ""}`
        : task.lane === "human-review"
          ? `None yet. Approving records acceptance${task.publishing.enabled ? "; then the approved commit is pushed and one pull request opened" : `. ${task.publishing.why ?? ""}`}. Nothing is merged.`
          : task.publishing.enabled
            ? "None yet. One is opened when a person approves the tested commit."
            : `None. ${task.publishing.why ?? ""}`
      : publication.state === "failed"
        ? `Publishing failed (attempt ${publication.attempts}): ${publication.error ?? "no reason given"}. Nothing was merged.`
        : publication.state === "merged"
          ? "Merged on the repository host."
          : publication.state === "closed"
            ? "Closed on the repository host without a merge."
            : publication.state === "pr-open"
              ? "Open for review. Merging is done on the repository host, not by the team."
              : `${publication.state}.`;
  return (
    <>
      <Row label="Pull request">
        <span
          className="flex flex-col items-end gap-0.5 text-right"
          data-task-related-pr={publication?.state ?? "none"}
        >
          {url ? (
            external ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline-offset-2 hover:underline"
                data-task-related-pr-link
              >
                #{publication?.pullRequest?.number} on the repository host
              </a>
            ) : (
              <span className="font-mono text-[10px]" data-task-related-pr-link>
                {url} (stand-in host)
              </span>
            )
          ) : null}
          <span>{said}</span>
        </span>
      </Row>
      {publication ? (
        <Row label="Branch">
          <span className="font-mono text-[10px] break-all" data-task-related-branch>
            {publication.branch} · {publication.commit.slice(0, 10)}
          </span>
        </Row>
      ) : null}
    </>
  );
}

/** The value of the board choice for a task on no board. */
const NO_BOARD = "__no_board__";

type Tab = "details" | "history" | "info";

/**
 * A task with everything about it in one place: what is asked, what was said
 * and what happened, and where it stands. The Board and the Orchestrator
 * both open this, on the same record.
 */
export function TaskWorkspace(props: {
  readonly environmentId: EnvironmentId | null;
  readonly taskId: string;
  readonly from: "Board" | "Orchestrator";
  readonly onClose: () => void;
  readonly onOpenTask: (taskId: string | null) => void;
}) {
  const person = usePersonName();
  const read = useDeliveryRead(props.environmentId, `/api/tasks/${props.taskId}`, {
    pollMs: 3_000,
  });
  const task = useMemo(() => parseTask(read.body), [read.body]);
  const stale = useStaleReading(read.readAt);
  const act = useDeliveryAct(props.environmentId, "task seen");
  const actions = useTaskActions(props.environmentId, {
    onDone: read.refresh,
    onDiscarded: () => props.onClose(),
  });
  const [tab, setTab] = useState<Tab>("history");

  // Opened and looked at, what the team said is read.
  const unread = task?.card.unread ?? 0;
  const seenFor = useRef<string | null>(null);
  useEffect(() => {
    if (!task || task.isDraft) return;
    const key = `${task.id}:${task.timeline.length}`;
    if (unread === 0 || seenFor.current === key) return;
    if (document.visibilityState !== "visible") return;
    seenFor.current = key;
    void act(`/api/tasks/${task.id}/seen`, { by: person });
  }, [act, person, task, unread]);

  if (task?.isDraft) {
    return (
      <TaskEditor
        environmentId={props.environmentId}
        taskId={task.id}
        from={props.from}
        onClose={props.onClose}
        onSaved={(id) => props.onOpenTask(id)}
      />
    );
  }

  const primary = task?.actions.filter((action) =>
    ["approve", "reject", "publish", "submit", "deliver"].includes(action),
  );
  const others = task?.actions.filter((action) => !primary?.includes(action)) ?? [];

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-task-workspace={props.taskId}>
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex min-w-0 flex-1 items-center gap-1 py-1 [@media(min-width:640px)_and_(min-height:600px)]:flex-wrap [@media(min-width:640px)_and_(min-height:600px)]:gap-2 [@media(min-width:640px)_and_(min-height:600px)]:py-2">
            <Button
              size="xs"
              variant="ghost"
              onClick={props.onClose}
              aria-label={`Back to ${props.from}`}
            >
              <ArrowLeftIcon />
              <span className="hidden [@media(min-width:640px)_and_(min-height:600px)]:inline">
                {props.from}
              </span>
            </Button>
            {task ? (
              <>
                <span className="shrink-0 font-mono text-xs text-muted-foreground" data-task-number>
                  #{task.number}
                </span>
                <h1 className="min-w-0 flex-1 truncate text-sm font-medium [@media(min-width:640px)_and_(min-height:600px)]:flex-none">
                  {task.title}
                </h1>
                <PriorityPill priority={task.priority} by={task.priorityBy} />
                <Badge
                  size="sm"
                  variant="outline"
                  className="hidden [@media(min-width:640px)_and_(min-height:600px)]:inline-flex"
                  data-task-state={task.state}
                >
                  {LANE_TITLE[task.lane ?? ""] ?? task.state}
                  {task.held ? ", paused" : ""}
                </Badge>
                <span
                  className={cn(
                    "font-mono text-[10px] text-muted-foreground",
                    !stale && "hidden [@media(min-width:640px)_and_(min-height:600px)]:inline-flex",
                  )}
                >
                  {stale ? "stale" : "live"}
                </span>
              </>
            ) : null}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {task && others.length > 0 ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="What can be done with this task"
                        data-task-actions
                      />
                    }
                  >
                    <EllipsisIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    {others.map((action) => (
                      <MenuItem
                        key={action}
                        disabled={actions.busy}
                        onClick={() => actions.run(task.card, action)}
                      >
                        <span className="flex max-w-80 flex-col">
                          <span>{actionLabel(action, task.card)}</span>
                          <span className="text-xs text-muted-foreground">
                            {actionHelp(action, task.card)}
                          </span>
                        </span>
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              ) : null}
            </div>
          </div>
        </WorkspacePageHeader>

        {read.error ? (
          <p className="px-5 pt-3 text-sm text-warning">
            Delivery engine not reachable. {read.error} This is not an ordinary chat and it will not
            answer as one.
          </p>
        ) : null}
        {actions.problem ? (
          <p className="px-5 pt-3 text-sm text-warning" data-delivery-problem>
            {actions.problem}
          </p>
        ) : null}

        {task ? (
          <>
            <div
              className="flex shrink-0 gap-1 border-b border-border px-3 py-1.5 xl:hidden"
              role="tablist"
            >
              {(["details", "history", "info"] as const).map((item) => (
                <Button
                  key={item}
                  size="xs"
                  role="tab"
                  aria-selected={tab === item}
                  variant={tab === item ? "secondary" : "ghost"}
                  onClick={() => setTab(item)}
                  data-task-tab={item}
                >
                  {item === "details" ? "Task" : item === "history" ? "History" : "About"}
                  {item === "history" && task.questions.length + task.proposals.length > 0
                    ? ` (${task.questions.length + task.proposals.length})`
                    : ""}
                </Button>
              ))}
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)_19rem] xl:divide-x xl:divide-border">
              <div className={cn("min-h-0 xl:flex", tab === "details" ? "flex" : "hidden")}>
                <Details
                  environmentId={props.environmentId}
                  task={task}
                  onOpenTask={props.onOpenTask}
                />
              </div>
              <div className={cn("min-h-0 xl:flex", tab === "history" ? "flex" : "hidden")}>
                <Communications
                  key={task.id}
                  environmentId={props.environmentId}
                  task={task}
                  onChanged={read.refresh}
                />
              </div>
              <div className={cn("min-h-0 xl:flex", tab === "info" ? "flex" : "hidden")}>
                <Info
                  environmentId={props.environmentId}
                  from={props.from}
                  task={task}
                  onChanged={read.refresh}
                  onMoveTo={(lane) => actions.moveTo(task.card, lane, null)}
                  busy={actions.busy}
                />
              </div>
            </div>
            <DecisionBar
              task={task}
              actions={primary ?? []}
              busy={actions.busy}
              onAction={(action) => actions.run(task.card, action)}
            />
          </>
        ) : read.error ? null : (
          <p className="p-6 text-sm text-muted-foreground">
            {read.isPending ? "Reading the task." : "There is no such task."}
          </p>
        )}
      </div>
      {actions.dialog}
    </SidebarInset>
  );
}
