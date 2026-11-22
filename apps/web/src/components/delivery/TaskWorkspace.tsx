import * as Schema from "effect/Schema";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { TaskWorkspacePanels } from "./TaskWorkspacePanels";
import { TaskConversation } from "./TaskConversation";
import { TaskFacts } from "./TaskFacts";
import { useTaskConversation } from "./useTaskConversation";
import { fullAutoAttribution } from "../../lib/delivery";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { taskPanelRef, useRightPanelStore } from "../../rightPanelStore";
import { SharedTaskAllocation } from "./SharedBoard";
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
  ListChecksIcon,
  PencilIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  parseTask,
  repeatKeys,
  type TaskBriefing,
  type TaskView,
  type TimelineEntry,
} from "../../lib/delivery";
import { LANE_TITLE, messageStateLabel, sectionOf } from "../../lib/deliveryBoard";
import { boardLaneOf } from "../../lib/boardLanes";
import { cn } from "../../lib/utils";
import {
  useBoardStore,
  useDeliveryAct,
  useDeliveryRead,
  useMinuteClock,
  usePersonName,
  useStaleReading,
} from "../../state/delivery";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { actionHelp, actionLabel, useTaskActions } from "./taskActions";
import { TaskEditor } from "./TaskEditor";
import { TaskFileList } from "./taskFiles";
import { Age, Avatar, PriorityPill, time } from "./taskParts";
import { TaskComposer } from "./TaskComposer";
import { DecisionBar } from "./DecisionBar";
import { Details } from "./TaskDetails";
import { Info } from "./TaskInfo";
import { TaskDeploymentsPanel } from "./TaskDeploymentStatus";
import { CardDeliveryStatus } from "./CardDeliveryStatus";
import { DeliveryDiagnosticNotice } from "./DeliveryDiagnosticNotice";
import { deliveryReadDiagnostic } from "../../lib/deliveryStates";
import { BoardDelivery } from "./BoardDelivery";

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

/** A link from a line of the history to the section it points at, if it points at one. */
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
          <span className="font-medium text-foreground">{mine ? entry.by : entry.by}</span>
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
      className="max-h-[40dvh] shrink-0 overflow-y-auto overscroll-contain border-b border-warning/40 bg-warning/5 px-3 py-2 text-xs"
      data-task-brief
    >
      <button
        type="button"
        className="flex w-full cursor-pointer items-start gap-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="mt-0.5 shrink-0 font-medium text-warning-foreground">Needs you</span>
        <span className="min-w-0 flex-1 font-medium">{brief.headline}</span>
        <span className="shrink-0 text-3xs text-muted-foreground">{open ? "Less" : "More"}</span>
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
                        <span className="ml-1 rounded bg-warning/15 px-1 text-3xs text-warning-foreground">
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

const replySequenceSchema = Schema.NullOr(Schema.Number);

function Communications(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: TaskView;
  readonly onChanged: () => void;
  /** Shows a section of the task: the checklist or the plan a line of the history points at. */
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
  const replying = replyTo;

  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useEffect(() => {
    const node = scroller.current;
    if (node && atEnd.current) node.scrollTop = node.scrollHeight;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Follow new visible entries without scrolling again on unrelated renders.
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
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <h2 className="text-xs font-medium">History and messages</h2>
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
      {problem ? <p className="px-3 pb-1 text-sm text-warning">{problem}</p> : null}
      <TaskComposer
        expanded={composerExpanded}
        onExpandedChange={setComposerExpanded}
        environmentId={props.environmentId}
        task={task}
        replyTo={replying}
        onReplyTo={setReplyTo}
        onReplySent={(seq) => setReplySeq((current) => (current === seq ? null : current))}
        onSent={props.onChanged}
      />
    </section>
  );
}

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
  const task = parseTask(read.body);
  const stale = useStaleReading(read.readAt);
  const act = useDeliveryAct(props.environmentId, "task seen");
  const actions = useTaskActions(props.environmentId, {
    onDone: read.refresh,
    onDiscarded: () => props.onClose(),
  });
  const detailsSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const [detailsOpen, setDetailsOpen] = useLocalStorage(
    `t3code:task-details:${JSON.stringify([props.environmentId, props.taskId, detailsSheet ? "sheet" : "inline"])}`,
    !detailsSheet,
    Schema.Boolean,
  );
  const [briefOpen, setBriefOpen] = useState(true);
  const [taskBrief, setTaskBrief] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [createProblem, setCreateProblem] = useState<string | null>(null);
  const [allocatingTask, setAllocatingTask] = useState<string | null>(null);
  const wide = useMediaQuery("(min-width: 640px) and (min-height: 600px)");
  const conversation = useTaskConversation(task);
  // A thread opened from a panel appears in the centre, so a panel that covers it, or fills the
  // width, gives way. The right panel stays on the task otherwise.
  const openInCentre = (thread: ScopedThreadRef) => {
    conversation.open(thread);
    const panel = taskPanelRef(JSON.stringify([props.environmentId, props.taskId]));
    useRightPanelStore.getState().setMaximized(panel, false);
    if (detailsSheet) {
      useRightPanelStore.getState().close(panel);
      setDetailsOpen(false);
    }
  };

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
    ["approve", "reject", "publish", "submit", "deliver", "accept-artifacts"].includes(action),
  );
  const others = task?.actions.filter((action) => !primary?.includes(action)) ?? [];

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-task-workspace={props.taskId}>
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1 py-1 [@media(min-width:640px)_and_(min-height:600px)]:gap-2 [@media(min-width:640px)_and_(min-height:600px)]:py-2",
              // With the thread view below, one row: the title gives way so the controls it draws stay clear.
              conversation.state.kind !== "open" &&
                "[@media(min-width:640px)_and_(min-height:600px)]:flex-wrap",
            )}
          >
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
                <h1
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm font-medium",
                    conversation.state.kind !== "open" &&
                      "[@media(min-width:640px)_and_(min-height:600px)]:flex-none",
                  )}
                >
                  {task.title}
                </h1>
                <PriorityPill priority={task.priority} by={task.priorityBy} />
                <Badge
                  size="sm"
                  variant="outline"
                  className="hidden [@media(min-width:640px)_and_(min-height:600px)]:inline-flex"
                  data-task-state={task.state}
                >
                  {LANE_TITLE[boardLaneOf(task.lane ?? "")] ?? task.state}
                  {task.held ? ", paused" : ""}
                </Badge>
                <span
                  className={cn(
                    "font-mono text-3xs text-muted-foreground",
                    !stale && "hidden [@media(min-width:640px)_and_(min-height:600px)]:inline-flex",
                  )}
                >
                  {stale ? "stale" : "live"}
                </span>
              </>
            ) : null}
            <div
              className={cn(
                "ml-auto flex shrink-0 items-center gap-1",
                // The thread view in the centre draws its own controls over the top right corner.
                conversation.state.kind === "open" && "pe-32",
              )}
            >
              {task?.workflow === "chat" && task.state === "chat" ? (
                <span className="hidden [@media(min-width:640px)_and_(min-height:600px)]:inline-flex">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      setCreateProblem(null);
                      setTaskBrief("");
                    }}
                  >
                    Create task from chat
                  </Button>
                </span>
              ) : null}
              {task ? (
                <SharedTaskAllocation
                  environmentId={props.environmentId}
                  taskId={task.id}
                  open={allocatingTask === task.id}
                  onOpenChange={(open) => setAllocatingTask(open ? task.id : null)}
                />
              ) : null}
              {task && (!wide || others.length > 0) ? (
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
                    {!wide && task.workflow === "chat" && task.state === "chat" ? (
                      <MenuItem
                        disabled={actions.busy}
                        onClick={() => {
                          setCreateProblem(null);
                          setTaskBrief("");
                        }}
                      >
                        <span className="flex max-w-80 flex-col">
                          <span>Create task from chat</span>
                          <span className="text-xs text-muted-foreground">
                            Make this chat a task; nothing starts yet.
                          </span>
                        </span>
                      </MenuItem>
                    ) : null}
                    {!wide ? (
                      <MenuItem disabled={actions.busy} onClick={() => setAllocatingTask(task.id)}>
                        <span className="flex max-w-80 flex-col">
                          <span>Allocate</span>
                          <span className="text-xs text-muted-foreground">
                            Choose the machine for it, or follow its move.
                          </span>
                        </span>
                      </MenuItem>
                    ) : null}
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
          deliveryReadDiagnostic(read.failure, { task: true }) === "unreachable" ? (
            <p className="px-5 pt-3 text-sm text-warning">
              Delivery engine not reachable. {read.error} This is not an ordinary chat and it will
              not answer as one.
            </p>
          ) : (
            <DeliveryDiagnosticNotice
              className="min-w-0 space-y-0.5 px-5 pt-3 text-sm"
              code={deliveryReadDiagnostic(read.failure, { task: true })}
              problem={read.error}
            />
          )
        ) : null}
        {actions.problem ? (
          <p className="px-5 pt-3 text-sm text-warning" data-delivery-problem>
            {actions.problem}
          </p>
        ) : null}

        {task ? (
          <>
            {props.environmentId && task.origin.startsWith(`thread:${props.environmentId}/`) ? (
              <BoardDelivery
                key={`${props.environmentId}:${task.id}`}
                environmentId={props.environmentId}
                task={{
                  id: task.id,
                  origin: task.origin,
                  held: task.held,
                  state: task.state,
                  repository: task.target?.repository ?? null,
                  base: task.target?.base ?? null,
                }}
              />
            ) : null}
            <TaskWorkspacePanels
              key={`${props.environmentId}:${task.id}`}
              owner={JSON.stringify([props.environmentId, task.id])}
              source={
                task.source
                  ? {
                      environmentId: EnvironmentId.make(task.source.environmentId),
                      threadId: ThreadId.make(task.source.threadId),
                    }
                  : null
              }
              detailsOpen={detailsOpen}
              onDetailsOpenChange={setDetailsOpen}
              onOpenThread={openInCentre}
              openFirst
              details={
                <Details
                  key={task.id}
                  environmentId={props.environmentId}
                  task={task}
                  onOpenTask={props.onOpenTask}
                  open={briefOpen}
                  onOpenChange={setBriefOpen}
                />
              }
              renderConversation={(showDetails) => (
                <TaskConversation
                  key={task.id}
                  task={task}
                  state={conversation.state}
                  seat={conversation.seat}
                  seatResolving={conversation.seatResolving}
                  seatName={conversation.seatName}
                  onOpenThread={openInCentre}
                  onBackToTask={conversation.backToTask}
                  log={
                    <Communications
                      key={task.id}
                      environmentId={props.environmentId}
                      task={task}
                      onChanged={read.refresh}
                      onShow={(section) => {
                        showDetails();
                        setBriefOpen(true);
                        requestAnimationFrame(() =>
                          document
                            .querySelector(`[data-task-section="${section}"]`)
                            ?.scrollIntoView({ block: "start", behavior: "smooth" }),
                        );
                      }}
                    />
                  }
                />
              )}
              deployments={
                <div className="flex min-w-0 flex-1 flex-col">
                  <CardDeliveryStatus card={task.card} variant="panel" />
                  <TaskDeploymentsPanel card={task.card} stale={stale || !!read.error} />
                </div>
              }
              evidence={
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <TaskFacts
                    environmentId={props.environmentId}
                    task={task}
                    stale={stale || !!read.error}
                    conversations={{ ...conversation.seats, open: openInCentre }}
                  />
                  <Info
                    key={task.id}
                    environmentId={props.environmentId}
                    from={props.from}
                    task={task}
                    onChanged={read.refresh}
                    stale={stale || !!read.error}
                    onMoveTo={(lane) => actions.moveTo(task.card, lane, null)}
                    busy={actions.busy}
                  />
                </div>
              }
            />
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
      <Dialog
        open={taskBrief !== null}
        onOpenChange={(open) => {
          if (!open && !creatingTask) setTaskBrief(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Create a non-code task</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Write the agreed brief. The draft keeps this conversation, project folder and
                attachments. Creating it does not start work.
              </p>
              <Textarea
                aria-label="Agreed task brief"
                value={taskBrief ?? ""}
                disabled={creatingTask}
                onChange={(event) => setTaskBrief(event.target.value)}
              />
              {createProblem ? <p role="alert">{createProblem}</p> : null}
              <Button
                disabled={creatingTask || !taskBrief?.trim() || !task}
                onClick={() => {
                  if (!task || !taskBrief?.trim() || creatingTask) return;
                  setCreatingTask(true);
                  void act(`/api/tasks/${task.id}/from-chat`, { text: taskBrief, by: person }).then(
                    (result) => {
                      setCreatingTask(false);
                      if (!result.ok) {
                        setCreateProblem(result.why);
                        return;
                      }
                      const created = parseTask(result.body);
                      if (!created) {
                        setCreateProblem("The engine did not return a task draft.");
                        return;
                      }
                      setTaskBrief(null);
                      read.refresh();
                      props.onOpenTask(created.id);
                    },
                  );
                }}
              >
                {creatingTask ? "Creating draft..." : "Create draft"}
              </Button>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </SidebarInset>
  );
}
