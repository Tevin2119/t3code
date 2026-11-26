import { T, Var, useGT, useMessages } from "gt-react";
import { BringLinkedTask } from "./LinkedTaskMoves";
import type { EnvironmentId } from "@t3tools/contracts";
import { ArrowLeftIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { boardLaneOf, boardLaneTitle } from "../../lib/boardLanes";
import { parseCard, parseTimeline, type DeliveryCard } from "../../lib/delivery";
import { LANE_TITLE, messageStateLabel } from "../../lib/deliveryBoard";
import { LINKED_DIAGNOSTIC_TEXT } from "../../lib/linkedBoards";
import {
  useLinkedTask,
  useLinkedTaskCommands,
  useMinuteClock,
  type LinkedActionOutcome,
} from "../../state/delivery";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Textarea } from "../ui/textarea";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { actionLabel } from "./taskActions";
import { Happening } from "./TaskEngineLog";
import { Age, Avatar, PriorityPill, Row, TagList, time, WaitingOn } from "./taskParts";

/**
 * A linked machine's task: its facts, the messages said on it, and the engine's timeline, read
 * through the link and refreshed on demand and after each action. Comments, answers, pause,
 * resume and steers go back over the same link; a read-only link reads, and says so. Nothing
 * here streams: this is the snapshot the link last answered.
 */
export function LinkedTaskPage(props: {
  readonly environmentId: EnvironmentId | null;
  readonly peerEnvironmentId: EnvironmentId;
  readonly taskId: string;
  readonly machine: string;
  /** This connection may act on the machine's tasks. */
  readonly allowed: boolean;
  /** The link itself is read-only: reading works, nothing sent from here is. */
  readonly readOnly: boolean;
  readonly onBack: () => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const read = useLinkedTask(props.environmentId, props.peerEnvironmentId, props.taskId);
  const commands = useLinkedTaskCommands({
    environmentId: props.environmentId,
    peerEnvironmentId: props.peerEnvironmentId,
  });
  const canAct = props.allowed && commands.allowed;
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const data = read.task;
  const task = data?.task ?? null;
  const card = task ? parseCard({ ...task.card, set: task.card.board.id }) : null;
  const timeline = data
    ? parseTimeline(data.timeline).filter((entry) => entry.source !== "message")
    : [];
  const closed = task !== null && ["rejected", "closed"].includes(task.state);
  // Every action ends with a refresh, so what the link answered next is what is shown.
  const run = async (send: () => Promise<LinkedActionOutcome>) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await send();
    setBusy(false);
    setProblem(
      outcome.ok
        ? (outcome.message ?? (outcome.diagnostic && LINKED_DIAGNOSTIC_TEXT[outcome.diagnostic]))
        : outcome.why,
    );
    read.refresh();
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-linked-task={props.taskId}>
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel={gt("Thread breadcrumb")} className="min-w-0 flex-1">
          <WorkspaceBreadcrumbItem>
            <button
              type="button"
              onClick={props.onBack}
              className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              data-linked-task-back
            >
              <ArrowLeftIcon className="size-3.5 shrink-0" />
              <WorkspaceBreadcrumbText>
                {props.machine}
                <T> · shared boards</T>
              </WorkspaceBreadcrumbText>
            </button>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator>
            <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbSeparator>
          <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
            <h2 className="min-w-0">
              <WorkspaceBreadcrumbText>
                {task ? `#${task.number} ${task.title}` : gt("Task")}
              </WorkspaceBreadcrumbText>
            </h2>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <div className="flex shrink-0 items-center gap-1">
          {props.allowed &&
            commands.controlAllowed &&
            task?.card.actions.map((action) => (
              <Button
                key={action}
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => commands.control(props.taskId, action))}
                data-linked-task-action={action}
              >
                {actionLabel(action, card)}
              </Button>
            ))}
          {props.allowed && !props.readOnly && props.environmentId && task && (
            <BringLinkedTask
              environmentId={props.environmentId}
              peerEnvironmentId={props.peerEnvironmentId}
              taskId={task.id}
              machine={props.machine}
            />
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={gt("Refresh task")}
            disabled={read.isPending}
            onClick={read.refresh}
            data-linked-task-refresh
          >
            <RefreshIcon refreshing={read.isPending} />
          </Button>
        </div>
      </WorkspacePageHeader>

      {problem ? (
        <p
          className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-1.5 text-xs text-warning"
          data-delivery-problem
        >
          <span className="min-w-0 flex-1">{problem}</span>
          <button type="button" className="cursor-pointer" onClick={() => setProblem(null)}>
            <T>Dismiss</T>
          </button>
        </p>
      ) : null}
      {read.error ? (
        <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-warning">
          <T>The task could not be read. </T>
          {read.error}
        </p>
      ) : null}
      {read.diagnostic ? (
        <p
          className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
          data-linked-diagnostic
        >
          {LINKED_DIAGNOSTIC_TEXT[read.diagnostic]}{" "}
          <button
            type="button"
            className="cursor-pointer text-primary underline-offset-2 hover:underline"
            onClick={props.onBack}
          >
            <T>Back to the board</T>
          </button>
        </p>
      ) : null}

      {!task || !data ? (
        <p className="p-6 text-sm text-muted-foreground" role="status">
          {props.environmentId === null
            ? gt("This environment is unavailable. Choose an added environment.")
            : gt("Reading the task...")}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <LinkedTaskFacts card={card} body={task.body} stage={stageOf(card, m)} />
          {task.questions.length > 0 ? (
            <section className="flex min-w-0 flex-col gap-2" data-linked-questions>
              <h3 className="text-xs font-medium text-muted-foreground">
                <T>Questions</T>
              </h3>
              {task.questions.map((question) => (
                <LinkedQuestion
                  key={question.seq}
                  environmentId={props.environmentId}
                  question={question}
                  canAct={canAct && !closed}
                  busy={busy}
                  onAnswer={(replyTo, answer) =>
                    void run(() => commands.answer(props.taskId, replyTo, answer))
                  }
                />
              ))}
            </section>
          ) : null}
          {data.messages.length > 0 ? (
            <section className="flex min-w-0 flex-col gap-2" data-linked-messages>
              <h3 className="text-xs font-medium text-muted-foreground">
                <T>Conversation</T>
              </h3>
              {data.messages.map((message) => (
                <LinkedMessage
                  key={message.seq}
                  environmentId={props.environmentId}
                  message={message}
                />
              ))}
            </section>
          ) : null}
          {timeline.length > 0 ? (
            <section className="flex min-w-0 flex-col gap-2" data-linked-timeline>
              <h3 className="text-xs font-medium text-muted-foreground">
                <T>Timeline</T>
              </h3>
              {timeline.map((entry) => (
                <Happening key={entry.id} entry={entry} />
              ))}
            </section>
          ) : null}
        </div>
      )}

      {task && (props.readOnly || !closed) ? (
        canAct ? (
          <LinkedComposer
            busy={busy}
            onComment={(text) => void run(() => commands.comment(props.taskId, text))}
            onSteer={(text) => void run(() => commands.steer(props.taskId, text))}
          />
        ) : (
          <p
            className="shrink-0 border-t border-border px-3 py-2 text-xs text-muted-foreground"
            data-linked-cannot-act
          >
            {props.readOnly
              ? gt("This link is read-only.")
              : gt("This connection cannot act on tasks on that machine.")}
          </p>
        )
      ) : null}
    </div>
  );
}

const stageOf = (card: DeliveryCard | null, m: ReturnType<typeof useMessages>): string => {
  if (!card) return "";
  return boardLaneTitle(
    boardLaneOf(card.lane),
    m,
    LANE_TITLE[boardLaneOf(card.lane)] ?? card.state,
  );
};

/** The task's own words and where it stands, in the rows the local task's details use. */
function LinkedTaskFacts(props: {
  readonly card: DeliveryCard | null;
  readonly body: string;
  readonly stage: string;
}) {
  const gt = useGT();
  const now = useMinuteClock();
  const { card } = props;
  return (
    <section className="flex min-w-0 flex-col gap-2" data-linked-task-facts>
      <h2 className="text-sm font-medium break-words">
        {card ? `#${card.number} ${card.title}` : gt("Task")}
      </h2>
      {props.body ? <p className="text-sm break-words whitespace-pre-wrap">{props.body}</p> : null}
      {card ? (
        <div className="flex flex-col gap-1">
          <Row label={gt("Stage")}>
            <span data-linked-task-stage>{props.stage}</span>
          </Row>
          <Row label={gt("Priority")}>
            <PriorityPill priority={card.priority} by={card.priorityBy} />
          </Row>
          <Row label={gt("Now")}>
            <WaitingOn card={card} />
          </Row>
          {card.blocker ? (
            <Row label={gt("Blocked by")}>
              <span className="text-xs text-muted-foreground">{card.blocker}</span>
            </Row>
          ) : null}
          {card.tags.length > 0 ? (
            <Row label={gt("Tags")}>
              <TagList tags={card.tags} />
            </Row>
          ) : null}
          <Row label={gt("Owner")}>{card.owner || "nobody"}</Row>
          <Row label={gt("Last changed")}>
            <Age at={card.updated} now={now} label={gt("Last changed")} />
          </Row>
        </div>
      ) : null}
    </section>
  );
}

/** One question the machine's team asked, answered over the link in its own words or by option. */
function LinkedQuestion(props: {
  readonly environmentId: EnvironmentId | null;
  readonly question: NonNullable<
    ReturnType<typeof useLinkedTask>["task"]
  >["task"]["questions"][number];
  readonly canAct: boolean;
  readonly busy: boolean;
  readonly onAnswer: (
    replyTo: number,
    answer: { readonly text: string } | { readonly option: string },
  ) => void;
}) {
  const gt = useGT();
  const [text, setText] = useState("");
  const [option, setOption] = useState<string | null>(null);
  const options = props.question.options;
  return (
    <article
      className="rounded-lg border border-border bg-card p-3"
      data-linked-question={props.question.seq}
    >
      <p className="text-xs text-muted-foreground">
        <T>
          <Var>{props.question.by}</Var> asked · <Var>{time(props.question.at)}</Var>
        </T>
      </p>
      <ChatMarkdown
        text={props.question.text}
        cwd={undefined}
        environmentId={props.environmentId ?? undefined}
        parseRawHtml={false}
        allowMedia={false}
      />
      {options.length > 0 && props.canAct ? (
        <div className="flex flex-wrap gap-2">
          {options.map((choice) => (
            <Button
              key={choice.label}
              size="sm"
              variant={option === choice.label ? "default" : "outline"}
              disabled={props.busy}
              onClick={() => {
                setOption(choice.label);
                setText("");
              }}
              data-linked-question-option={choice.label}
            >
              {choice.label}
            </Button>
          ))}
          {option !== null ? (
            <Button size="sm" variant="ghost" disabled={props.busy} onClick={() => setOption(null)}>
              <T>Answer in my own words</T>
            </Button>
          ) : null}
        </div>
      ) : null}
      {props.canAct ? (
        <div className="flex flex-col gap-2">
          {option === null ? (
            <Textarea
              aria-label={gt("Reply to question {question}", { question: props.question.seq })}
              value={text}
              disabled={props.busy}
              onChange={(event) => setText(event.target.value)}
            />
          ) : (
            <p className="text-sm">
              {option}: {options.find((choice) => choice.label === option)?.meaning ?? option}
            </p>
          )}
          <div className="self-start">
            <Button
              size="sm"
              disabled={props.busy || (!text.trim() && option === null)}
              onClick={() => {
                props.onAnswer(
                  props.question.seq,
                  option !== null ? { option } : { text: text.trim() },
                );
                setText("");
                setOption(null);
              }}
              data-linked-question-answer
            >
              <T>Send reply</T>
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

/** One message said on the task, read as the question replies the engine renders. */
function LinkedMessage(props: {
  readonly environmentId: EnvironmentId | null;
  readonly message: {
    readonly seq: number;
    readonly at: string;
    readonly from: string;
    readonly by: string;
    readonly kind: string;
    readonly text: string;
    readonly state: string;
    readonly replyTo: number | null;
  };
}) {
  const gt = useGT();
  const { message } = props;
  const mine = message.from === "person";
  const state = messageStateLabel(message.state, null);
  return (
    <div
      className={`flex max-w-7/8 gap-2 ${mine ? "ml-auto flex-row-reverse" : ""}`}
      data-linked-message={message.seq}
      data-message-kind={message.kind}
      data-message-state={message.state}
    >
      <Avatar
        name={message.by}
        seat={!mine}
        detail={mine ? message.by : gt("{author}, team", { author: message.by })}
      />
      <div
        className={`flex min-w-0 flex-col gap-1 rounded-lg border border-border px-3 py-2 text-sm ${
          mine ? "bg-accent" : ""
        }`}
      >
        <p className="text-3xs text-muted-foreground">
          <span className="font-medium text-foreground">{message.by}</span>, {message.kind},{" "}
          {time(message.at)}
        </p>
        <ChatMarkdown
          text={message.text}
          cwd={undefined}
          environmentId={props.environmentId ?? undefined}
          parseRawHtml={false}
          allowMedia={false}
        />
        {state && (mine || message.state === "open") ? (
          <p className="text-3xs text-muted-foreground" data-message-state-label>
            {state}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What is written to the task over the link: a message for the record, or an instruction the
 * seats at work take up. Only reached where the link allows acting.
 */
function LinkedComposer(props: {
  readonly busy: boolean;
  readonly onComment: (text: string) => void;
  readonly onSteer: (text: string) => void;
}) {
  const gt = useGT();
  const [text, setText] = useState("");
  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border p-3" data-linked-composer>
      <Textarea
        aria-label={gt("Write to the task")}
        placeholder={gt(
          "Write to the task: a message for the record, or an instruction for the work",
        )}
        value={text}
        disabled={props.busy}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={props.busy || !text.trim()}
          onClick={() => {
            props.onComment(text.trim());
            setText("");
          }}
          data-linked-comment
        >
          <T>Send message</T>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={props.busy || !text.trim()}
          onClick={() => {
            props.onSteer(text.trim());
            setText("");
          }}
          data-linked-steer
        >
          <T>Give the instruction</T>
        </Button>
        <p className="min-w-0 flex-1 text-2xs text-muted-foreground">
          <T>
            An instruction reaches every seat at work; the step starts again with it once they have
            ended.
          </T>
        </p>
      </div>
    </div>
  );
}
