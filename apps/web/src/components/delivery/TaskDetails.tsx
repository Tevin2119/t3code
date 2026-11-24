import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { PencilIcon } from "lucide-react";
import { useRef, useState } from "react";

import { BOARD_LANE, boardLaneOf, boardLaneTitle } from "../../lib/boardLanes";
import { reworkOf, waitKindsOf, WORK_STAGE_TITLE, workStageOf } from "../../lib/boardLaneCards";
import {
  parseTarget,
  repeatKeys,
  seatSettingsToSend,
  TASK_PRIORITIES,
  targetLine,
  type TaskBrief,
  type TaskBriefing,
  type TaskPriority,
  type TaskView,
} from "../../lib/delivery";
import { LANE_TITLE, PRIORITY_LABEL, tagsFromText } from "../../lib/deliveryBoard";
import type { MoveBoard } from "../../lib/deliveryMove";
import { seatsChangedForTask } from "../../lib/deliverySeats";
import { taskConversation } from "../../lib/taskConversation";
import { cn } from "../../lib/utils";
import {
  useBoardStore,
  useDeliveryAct,
  useDeliveryRead,
  useMinuteClock,
  usePersonName,
  withSeatChoice,
} from "../../state/delivery";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { THREAD_DETAILS_ITEMS } from "../chat/threadDetailsItems";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useBoardTask, type BoardTask } from "./BoardTaskContext";
import { ReworkCount, WaitKinds } from "./BoardLaneCards";
import { SeatSettingsPanel } from "./SeatSettingsPanel";
import { TaskDisclosure } from "./TaskDisclosure";
import { TaskEngineLog } from "./TaskEngineLog";
import { TaskFileList } from "./taskFiles";
import {
  Age,
  laneTone,
  PriorityPill,
  priorityByWords,
  Row,
  TagList,
  time,
  WaitingOn,
} from "./taskParts";
import { TaskAcceptanceReceipts, TaskSeatHandoffs } from "./TaskSeatResults";
import { TaskPipelineStrip, TaskTeamActivity } from "./TaskTeamActivity";
import { ThreadTaskQuestions } from "./ThreadTaskQuestions";

const TASK_ITEM = THREAD_DETAILS_ITEMS.find((item) => item.id === "task")!;

const STEER_STATE: Record<
  string,
  { readonly label: string; readonly variant: "outline" | "warning" }
> = {
  pending: { label: "Waits for the next turn", variant: "outline" },
  delivered: { label: "Delivered", variant: "outline" },
  failed: { label: "Not delivered", variant: "warning" },
};

/**
 * The engine's mirror of the task's conversation and the steers queued for it (spec 6a, slice 5).
 * The conversation itself is the thread in the centre; this is what the card is told of it.
 */
function ConversationFacts(props: { readonly task: TaskView }) {
  const gt = useGT();
  const { conversation, steers } = props.task.card;
  const { boardThread, conversationMirrorEnvironment } = props.task;
  const transferred =
    boardThread &&
    conversationMirrorEnvironment &&
    boardThread.environmentId !== conversationMirrorEnvironment;
  const open = props.task.steers.filter((steer) => steer.state !== "delivered");
  if (conversation === null && (steers === null || open.length === 0)) return null;
  return (
    <>
      {conversation ? (
        <Row label="Conversation">
          <span className="flex min-w-0 flex-col items-end" data-task-conversation-mirror>
            <span>
              {conversation.count} {conversation.count === 1 ? "event" : "events"}
              {conversation.lastAt ? `, last ${time(conversation.lastAt)}` : ""}
            </span>
            {transferred ? (
              <span className="text-2xs text-muted-foreground">
                {gt(
                  "Activity is no longer mirrored after the conversation moved to another environment.",
                )}
              </span>
            ) : null}
            {conversation.lastExcerpt ? (
              <span className="line-clamp-2 text-2xs text-muted-foreground">
                {conversation.lastExcerpt}
              </span>
            ) : null}
          </span>
        </Row>
      ) : null}
      {open.length > 0 ? (
        <Row label="Steers">
          <ul className="flex min-w-0 flex-col items-end gap-1" data-task-steers>
            {open.map((steer) => (
              <li
                key={steer.id}
                className="flex min-w-0 flex-col items-end gap-0.5"
                data-task-steer={steer.state}
              >
                <span className="flex items-center gap-1">
                  <span className="text-2xs text-muted-foreground">
                    {steer.author}, {time(steer.created)}
                  </span>
                  <Badge size="sm" variant={STEER_STATE[steer.state]?.variant ?? "outline"}>
                    {STEER_STATE[steer.state]?.label ?? steer.state}
                  </Badge>
                </span>
                {steer.failure ? (
                  <span className="text-2xs text-warning-foreground">{steer.failure}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Row>
      ) : null}
    </>
  );
}

function Listed(props: {
  readonly title: string;
  readonly items: ReadonlyArray<string>;
  /** A name a line of the history can point at; see sectionOf. */
  readonly section?: string;
}) {
  if (props.items.length === 0) return null;
  return (
    <section data-task-section={props.section}>
      <h3 className="pb-1 text-xs font-medium text-muted-foreground">{props.title}</h3>
      <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm">
        {props.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

/** Dependencies and related tasks: a dependency is not a child, so it stays with the task's words. */
function Links(props: {
  readonly tasks: ReadonlyArray<
    TaskBrief & { readonly kind?: string; readonly direction?: string }
  >;
  readonly onOpen: (id: string) => void;
}) {
  if (props.tasks.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm" data-task-links>
      {props.tasks.map((item) => (
        <li key={`${item.id}:${item.kind ?? ""}:${item.direction ?? ""}`}>
          <button
            type="button"
            onClick={() => props.onOpen(item.id)}
            className="flex w-full cursor-pointer items-start gap-2 rounded px-1 py-1.5 text-left hover:bg-accent"
          >
            <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", laneTone(item.lane).bar)} />
            <span className="font-mono text-xs text-muted-foreground">#{item.number}</span>
            <span className="min-w-0 flex-1 break-words">{item.title}</span>
            <span className="max-w-28 shrink-0 text-right text-xs text-muted-foreground">
              {item.kind === "depends-on"
                ? item.direction === "out"
                  ? "this waits for it"
                  : "it waits for this"
                : ""}{" "}
              {LANE_TITLE[boardLaneOf(item.lane ?? "")] ?? item.state}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * What is needed of you, in plain words: the bottom line, then what the task is, what happened,
 * why it stopped, and what each choice would do. The steps themselves are in the decisions lane.
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
    <div
      className="rounded-md border border-warning/40 bg-warning/5 px-2.5 py-2 text-xs"
      data-task-brief
    >
      <button
        type="button"
        className="flex w-full cursor-pointer items-start gap-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
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

/** The stage the engine reports: the lane, the In work stage, and whether the task is held. */
export function useStageWords(task: TaskView): string {
  const gt = useGT();
  const m = useMessages();
  const lane = boardLaneOf(task.lane ?? "");
  return [
    boardLaneTitle(lane, m, LANE_TITLE[lane] ?? task.state),
    lane === BOARD_LANE.inWork ? m(WORK_STAGE_TITLE[workStageOf(task.card)]) : null,
    task.held ? gt("paused") : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * The Task item of the thread details: the task's words, where it stands, who owns it and how its
 * seats are set, all from the board's own read. It renders only where a board task's view hosts the
 * thread, so any other thread gets nothing from it, whatever the settings say.
 */
export function TaskDetailsItem() {
  const board = useBoardTask();
  const m = useMessages();
  if (!board?.task) return null;
  return (
    <ThreadDetailsSection
      headingId={`thread-details-task-${board.task.id}`}
      title={m(TASK_ITEM.label)}
      data-thread-details-task
    >
      <TaskDetailsBody key={board.task.id} board={board} task={board.task} />
    </ThreadDetailsSection>
  );
}

function TaskDetailsBody(props: { readonly board: BoardTask; readonly task: TaskView }) {
  const { board, task } = props;
  const gt = useGT();
  const { card } = task;
  const { environmentId } = board;
  const person = usePersonName();
  const name = useBoardStore((state) => state.person);
  const setPerson = useBoardStore((state) => state.setPerson);
  const act = useDeliveryAct(environmentId, "task edit");
  const stage = useStageWords(task);
  const [showRevisions, setShowRevisions] = useState(false);
  const [tags, setTags] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);
  const closed = ["approved", "rejected", "closed"].includes(task.state);
  const flow = task.flows.find((item) => item.id === task.workflow) ?? null;
  const rework = reworkOf(card);
  // The boards of the person's own, to name the one the task is on.
  const boardsRead = useDeliveryRead(environmentId, "/api/boards");
  const boards: ReadonlyArray<MoveBoard> = (
    Array.isArray(boardsRead.body) ? boardsRead.body : []
  ).flatMap((item: unknown) =>
    item && typeof item === "object" && "id" in item && "title" in item
      ? [
          {
            id: String(item.id),
            title: String(item.title),
            target: "target" in item ? parseTarget(item.target) : null,
          },
        ]
      : [],
  );
  // The board triage thinks the task belongs on. Moving it there is in the header's menu.
  const suggested = task.suggestedBoard ?? card.suggestedBoard ?? null;
  // What is set for the task, which the switches change.
  const set = Object.fromEntries(task.settings.map((item) => [item.seat, item.set]));
  // The seat choices last sent. Until a read of the task shows it changed since (its last change is
  // later), a second switch builds on the first, instead of on a read from before it, a poll
  // included, which would undo it.
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
    board.refresh();
  };
  const edit = async (patch: Record<string, unknown>) => {
    setProblem(null);
    const result = await act(`/api/tasks/${task.id}/edit`, { ...patch, by: person });
    if (!result.ok) setProblem(result.why);
    board.refresh();
  };
  const source = task.source;
  const container = useRef<HTMLDivElement>(null);
  const [askedOpen, setAskedOpen] = useState(true);
  // The log stands in for the conversation while the task has none, so it starts open then.
  const [logOpen, setLogOpen] = useState(() => taskConversation(task).kind !== "thread");
  const reveal = (selector: string) =>
    requestAnimationFrame(() =>
      container.current
        ?.querySelector(selector)
        ?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  const showSection = (section: "acceptance" | "plan") => {
    setAskedOpen(true);
    reveal(`[data-task-section="${section}"]`);
  };
  // A proposal owed is answered on its own entry in the log.
  const proposal = waitKindsOf(card).includes("proposal")
    ? (task.timeline.findLast((entry) => entry.kind === "proposal" && entry.state === "open") ??
      null)
    : null;

  // The engine's own questions are answered here; a question the lead asks in the conversation
  // is answered there, as any thread's request is.
  const asks = environmentId !== null && task.questions.length > 0;

  return (
    <div ref={container} className="flex min-w-0 flex-col gap-2 px-2.5" data-task-details>
      {card.waitingOn === "person" || asks ? (
        <TaskDisclosure title={gt("Needs you")}>
          <WaitKinds card={card} />
          {asks && environmentId !== null ? (
            <ThreadTaskQuestions
              environmentId={environmentId}
              tasks={[card]}
              summaryTaskIds={[card.id]}
            />
          ) : null}
          {proposal ? (
            <button
              type="button"
              className="self-start text-xs text-primary underline-offset-2 hover:underline"
              onClick={() => {
                setLogOpen(true);
                reveal(`[data-timeline-entry="${CSS.escape(proposal.id)}"]`);
              }}
              data-task-see-proposal
            >
              {gt("See the proposal")}
            </button>
          ) : null}
          {task.brief ? <Briefing brief={task.brief} /> : null}
        </TaskDisclosure>
      ) : null}

      <TaskDisclosure title={gt("Where it stands")}>
        <TaskPipelineStrip task={task} />
        <Row label={gt("Stage")}>
          <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
            <span data-task-details-stage>{stage}</span>
            {rework ? <ReworkCount rounds={rework.rounds} /> : null}
          </span>
        </Row>
        {task.working ? (
          <p className="text-xs text-muted-foreground" data-task-working>
            The engine is moving this task on.
          </p>
        ) : null}
        {board.stale ? (
          <p className="text-xs text-warning-foreground" data-task-details-stale>
            {gt("This is the last reading. The engine has not answered since.")}
          </p>
        ) : null}
        {card.waitingOn === "person" ? null : <WaitKinds card={card} />}
        <Row label="Now">
          <WaitingOn card={card} />
        </Row>
        <ConversationFacts task={task} />
        {card.blocker ? (
          <p
            className={cn(
              "rounded border px-2 py-1 text-xs",
              card.waitingOn === "person"
                ? "border-warning/60 bg-warning/5"
                : "border-border text-muted-foreground",
            )}
            data-task-blocker
          >
            {card.blocker}
          </p>
        ) : null}
        {card.set === "qualification" ? (
          <Row label="Kept as">
            <span data-task-set="qualification">the qualification's evidence, not pilot work</span>
          </Row>
        ) : (
          <Row label="Board">
            {/* A board other than the suggested one is outlined in the warning tone. */}
            <span
              className={cn(
                "inline-flex min-w-0 rounded-md",
                suggested && suggested.id !== card.set && "px-1 ring-1 ring-warning/60",
              )}
              data-task-board={card.set ?? ""}
            >
              {boards.find((item) => item.id === card.set)?.title ??
                (card.set ? card.set : "Not on a board")}
            </span>
          </Row>
        )}
      </TaskDisclosure>

      {task.council?.seats.some(
        (seat) => seat.threadId || seat.seatThread || seat.attestedModel || seat.actualModel,
      ) ? (
        <TaskTeamActivity
          environmentId={environmentId}
          task={task}
          conversations={board.seats}
          flow={false}
          conversationLabels={{ title: gt("Seats"), open: gt("Open conversation") }}
        />
      ) : null}
      <TaskSeatHandoffs handoffs={task.handoffs} />

      <TaskDisclosure
        title={`What is asked, revision ${task.revision}`}
        open={askedOpen}
        onOpenChange={setAskedOpen}
      >
        <p className="text-sm break-words whitespace-pre-wrap" data-task-asked>
          {task.body}
        </p>
        {task.plan ? (
          <section
            className="flex flex-col gap-2 rounded-md border border-border p-2"
            data-task-plan
            data-task-section="plan"
          >
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
            <p className="font-mono text-3xs break-all text-muted-foreground">{task.plan.file}</p>
          </section>
        ) : null}
        <Listed title="Requirements" items={task.requirements} />
        {task.qaReceipts === null ? (
          <Listed title={gt("Acceptance criteria")} items={task.acceptance} section="acceptance" />
        ) : (
          <TaskAcceptanceReceipts acceptance={task.acceptance} receipts={task.qaReceipts} />
        )}
        {task.files.length > 0 ? (
          <section>
            <h3 className="pb-1 text-xs font-medium text-muted-foreground">
              Files ({task.files.length})
            </h3>
            <TaskFileList environmentId={environmentId} files={task.files} />
          </section>
        ) : null}
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
                    <p className="font-mono text-3xs text-muted-foreground">
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
      </TaskDisclosure>

      <div data-task-section="log">
        <TaskDisclosure title={gt("Engine log")} open={logOpen} onOpenChange={setLogOpen}>
          <TaskEngineLog
            environmentId={environmentId}
            task={task}
            onChanged={board.refresh}
            onShow={showSection}
          />
        </TaskDisclosure>
      </div>

      {task.links.length > 0 ? (
        <TaskDisclosure title="Dependencies and related tasks">
          <Links tasks={task.links} onOpen={board.openTask} />
        </TaskDisclosure>
      ) : null}

      <TaskDisclosure title="Ownership and repository">
        <Row label="Priority">
          <span className="flex flex-col items-end gap-0.5">
            {closed ? (
              <PriorityPill priority={task.priority} />
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
            {task.priorityBy ? (
              <span className="text-3xs text-muted-foreground" data-task-priority-by>
                {priorityByWords(task.priorityBy)}
              </span>
            ) : null}
          </span>
        </Row>
        {/* Where its work is done. A task keeps it; moving it to another board does not change it. */}
        <Row label="Repository">
          <span
            className="flex min-w-0 flex-col"
            data-task-target={task.target?.ok ? "ok" : "none"}
          >
            <span className={task.target?.ok ? "" : "text-warning"}>{targetLine(task.target)}</span>
            {task.target?.ok && task.target.path ? (
              <span className="truncate font-mono text-2xs text-muted-foreground">
                {task.target.path}
              </span>
            ) : null}
          </span>
        </Row>
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
              size="compact"
              className="w-36"
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
          <span className="font-mono text-3xs">{task.id}</span>
        </Row>
        {problem ? <p className="text-xs text-warning">{problem}</p> : null}
      </TaskDisclosure>

      <TaskDisclosure title="Linked conversations" defaultOpen={false}>
        <p className="text-2xs text-muted-foreground">
          What is said on this task is its conversation with the team. A thread in the chat list is
          a conversation of its own; it becomes a task only when you create one from it.
        </p>
        {source ? (
          <Row label="Made from">
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              data-task-related-source
              onClick={() =>
                board.openThread({
                  environmentId: EnvironmentId.make(source.environmentId),
                  threadId: ThreadId.make(source.threadId),
                })
              }
            >
              the conversation it came from
            </button>
          </Row>
        ) : null}
      </TaskDisclosure>

      {closed ? null : (
        <TaskDisclosure title="Seat settings" defaultOpen={false}>
          <div className="flex flex-col gap-2" data-task-seats>
            <SeatSettingsPanel
              environmentId={environmentId}
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
                className="rounded border border-border bg-muted/40 px-2 py-1.5 text-2xs"
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
              <ul className="list-disc pl-5 text-2xs text-warning" data-delivery-problem>
                {problems.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            <p className="text-2xs text-muted-foreground">
              {task.workflow === "chat"
                ? "A change counts from the next message on."
                : "A run keeps the seats it started with. A change counts for the next run. A seat that is working when it is switched off is asked to stop."}
            </p>
          </div>
        </TaskDisclosure>
      )}

      <section className="flex flex-col gap-1 pb-1">
        <h3 className="text-xs font-medium text-muted-foreground">Your name</h3>
        <Input
          aria-label="Your name"
          placeholder="Written on what you do here"
          size="compact"
          value={name}
          onChange={(event) => setPerson(event.target.value)}
        />
      </section>
    </div>
  );
}
