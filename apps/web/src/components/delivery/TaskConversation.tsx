import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ArrowLeftIcon, CornerDownRightIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";

import type { TaskView } from "../../lib/delivery";
import { queueWait, type ConversationState, type SeatThread } from "../../lib/taskConversation";
import { linkedThreadSurface } from "../../linkedThreadSurface";
import { ThreadInspectionContext } from "../chat/ThreadInspectionContext";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { ToggleGroup } from "../ui/toggle-group";
import { QueueLine } from "./BoardLaneCards";

const ChatView = lazy(() => import("../ChatView"));
const LinkedThread = lazy(() =>
  import("../chat/LinkedThreadPane").then((module) => ({ default: module.LinkedThread })),
);

/** The task's own words, kept on the screen whenever the conversation cannot be. */
function TaskText(props: { readonly task: TaskView }) {
  const { task } = props;
  return (
    <section className="flex flex-col gap-1" data-task-text>
      <h2 className="text-sm font-medium break-words">{task.title}</h2>
      {task.body ? <p className="text-sm break-words whitespace-pre-wrap">{task.body}</p> : null}
    </section>
  );
}

/** What the engine says a queued task waits for. Nothing is estimated or worked out here. */
function QueueReason(props: { readonly task: TaskView }) {
  const gt = useGT();
  const wait = queueWait(props.task.card);
  return (
    <div className="flex flex-col gap-1" data-task-queue-reason>
      {wait.place !== null || !wait.submitted ? (
        <QueueLine card={props.task.card} place={wait.place} />
      ) : (
        <p className="text-2xs text-muted-foreground">
          {gt("This engine does not report the slots or who holds them yet. The order is its own.")}
        </p>
      )}
      {wait.blocker ? <p className="text-xs text-muted-foreground">{wait.blocker}</p> : null}
    </div>
  );
}

/** A draft or a queued task: no conversation yet, so the text and the reason, and no composer. */
function ConversationWaiting(props: { readonly task: TaskView; readonly why: "draft" | "queued" }) {
  const gt = useGT();
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
      data-task-conversation="waiting"
      data-task-conversation-why={props.why}
    >
      <TaskText task={props.task} />
      {props.why === "queued" ? <QueueReason task={props.task} /> : null}
      <p className="text-xs text-muted-foreground" role="status">
        {props.why === "queued"
          ? gt(
              "The team's conversation starts when this task gets a slot. There is nothing to answer yet.",
            )
          : gt(
              "The team's conversation starts when this task is started. There is nothing to answer yet.",
            )}
      </p>
    </div>
  );
}

/**
 * The thread view threw while mounting (its composer can fail to start the first time the page
 * loads). The first failure mounts it again once; a second one asks the person to.
 */
function ConversationFailed(props: { readonly attempt: number; readonly onRetry: () => void }) {
  const gt = useGT();
  const retried = props.attempt > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one automatic remount of the thread view after it failed to mount
  useEffect(() => {
    if (!retried) props.onRetry();
  }, [retried, props]);
  return retried ? (
    <div className="flex flex-col items-start gap-2 p-4" role="alert">
      <p className="text-sm">{gt("The conversation could not be shown.")}</p>
      <Button size="xs" variant="outline" onClick={props.onRetry}>
        {gt("Try again")}
      </Button>
    </div>
  ) : null;
}

/** The line above a seat's conversation: whose it is, and the way back to the task. */
function SeatBar(props: {
  readonly task: TaskView;
  readonly seatName: string | null;
  readonly onBack: () => void;
}) {
  const gt = useGT();
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1"
      data-task-seat-bar
    >
      <Button size="xs" variant="ghost" onClick={props.onBack} data-task-seat-back>
        <ArrowLeftIcon />
        {gt("Back to task #{number}", { number: props.task.number })}
      </Button>
      <CornerDownRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {props.seatName ? gt("Seat {seat}", { seat: props.seatName }) : gt("Seat conversation")}
      </span>
    </div>
  );
}

/**
 * A seat that runs in a linked environment this client is not connected to: its conversation read
 * through the task's environment, in the view a remote agent's thread already opens in.
 */
function LinkedSeat(props: {
  readonly seat: SeatThread;
  readonly linked: NonNullable<SeatThread["linked"]>;
}) {
  const surface = linkedThreadSurface({
    viaEnvironmentId: props.linked.viaEnvironmentId,
    environmentId: props.seat.environmentId,
    threadId: props.seat.threadId,
    label: props.linked.label,
    title: null,
  });
  return <LinkedThread key={surface.id} panelRef={null} surface={surface} visible />;
}

/**
 * The task's conversation in the centre, in the thread view T3 already has, its composer
 * included. A seat's conversation replaces it here with a way back, and the right panel does
 * not move. Until the lead's conversation carries what the engine still says in its log, the log
 * stays one toggle away: it is where a question waits and where a proposal is answered.
 */
function OpenConversation(props: {
  readonly task: TaskView;
  readonly thread: ScopedThreadRef;
  readonly offline: boolean;
  readonly seat: SeatThread | null;
  readonly seatName: string | null;
  readonly onOpenThread: (thread: ScopedThreadRef) => void;
  readonly onBackToTask: () => void;
  readonly log: ReactNode;
}) {
  const gt = useGT();
  const [view, setView] = useState<"conversation" | "log">("conversation");
  const [attempt, setAttempt] = useState(0);
  const shown = props.seat ?? props.thread;
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-task-conversation={props.seat ? "seat" : "open"}
    >
      {props.offline ? (
        <p
          className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
          role="status"
          data-task-conversation-offline
        >
          {gt(
            "T3 is not running, so the conversation is not available. It resumes when T3 is back. The engine keeps recording and nothing is cancelled.",
          )}
        </p>
      ) : null}
      {props.seat ? (
        <SeatBar task={props.task} seatName={props.seatName} onBack={props.onBackToTask} />
      ) : (
        <div className="flex shrink-0 items-center border-b border-border px-3 py-1">
          <ToggleGroup
            aria-label={gt("What the centre shows")}
            value={[view]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "conversation" || value === "log") setView(value);
            }}
          >
            <Toggle value="conversation">{gt("Conversation")}</Toggle>
            <Toggle value="log">{gt("Engine log")}</Toggle>
          </ToggleGroup>
        </div>
      )}
      {view === "log" && !props.seat ? (
        props.log
      ) : (
        <ThreadInspectionContext value={props.onOpenThread}>
          <RenderErrorBoundary
            resetKeys={[attempt, shown.threadId]}
            fallback={
              <ConversationFailed attempt={attempt} onRetry={() => setAttempt((n) => n + 1)} />
            }
          >
            <Suspense
              fallback={
                <p role="status" className="p-4 text-sm text-muted-foreground">
                  {gt("Loading the conversation...")}
                </p>
              }
            >
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {props.seat?.linked ? (
                  <LinkedSeat seat={props.seat} linked={props.seat.linked} />
                ) : (
                  <ChatView
                    key={`${shown.environmentId}:${shown.threadId}`}
                    environmentId={shown.environmentId}
                    threadId={shown.threadId}
                    routeKind="server"
                    reserveTitleBarControlInset={false}
                    unavailableContent={
                      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
                        <TaskText task={props.task} />
                        <p role="status" className="text-xs text-muted-foreground">
                          {gt(
                            "This conversation is loading or is not available here. The task's facts beside it stand.",
                          )}
                        </p>
                      </div>
                    }
                  />
                )}
              </div>
            </Suspense>
          </RenderErrorBoundary>
        </ThreadInspectionContext>
      )}
    </div>
  );
}

/**
 * The centre of the task view (BOARD-REVAMP-UI-SPEC section 6). Which conversation, and whether
 * T3 can serve it, are decided by `lib/taskConversation`; this only draws each case.
 */
export function TaskConversation(props: {
  readonly task: TaskView;
  readonly state: ConversationState;
  readonly seat: SeatThread | null;
  readonly seatName: string | null;
  readonly onOpenThread: (thread: ScopedThreadRef) => void;
  readonly onBackToTask: () => void;
  /** The engine's own log and its composer, for a task whose conversation is not known yet. */
  readonly log: ReactNode;
}) {
  const gt = useGT();
  const { state, task } = props;
  switch (state.kind) {
    case "waiting":
      return <ConversationWaiting task={task} why={state.why} />;
    case "unlinked":
      return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-task-conversation="unlinked">
          <p className="shrink-0 border-b border-border px-3 py-1.5 text-2xs text-muted-foreground">
            {gt(
              "No conversation is linked to this task yet. The engine's log stands in until one is.",
            )}
          </p>
          {props.log}
        </div>
      );
    case "open":
      return (
        <OpenConversation
          task={task}
          thread={state.ref}
          offline={state.offline}
          seat={props.seat}
          seatName={props.seatName}
          onOpenThread={props.onOpenThread}
          onBackToTask={props.onBackToTask}
          log={props.log}
        />
      );
  }
}
