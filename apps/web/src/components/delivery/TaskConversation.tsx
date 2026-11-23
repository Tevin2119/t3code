import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CornerDownRightIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import type { TaskView } from "../../lib/delivery";
import {
  queueWait,
  sameThread,
  type ConversationState,
  type SeatThread,
} from "../../lib/taskConversation";
import { cn } from "../../lib/utils";
import { linkedThreadSurface } from "../../linkedThreadSurface";
import { useRightPanelStore } from "../../rightPanelStore";
import type { ChatViewSlots } from "../ChatView";
import { ThreadInspectionContext } from "../chat/ThreadInspectionContext";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { QueueLine } from "./BoardLaneCards";

const ChatView = lazy(() => import("../ChatView"));
const LinkedThread = lazy(() =>
  import("../chat/LinkedThreadPane").then((module) => ({ default: module.LinkedThread })),
);

/** What the task view puts around its centre, in every state. */
export interface TaskChrome {
  /** The task's number and title: the header's title on its own thread. */
  readonly title: string;
  /** The header's overflow menu of what can be done with the task. */
  readonly actions: ReactNode;
  /** Lines under the header: the engine's notices, the last refusal, the delivery disclosure. */
  readonly notices: ReactNode;
  /** The task's own panel toggles on a page, whose details are the sheet. */
  readonly panelControls: ReactNode;
  /** The right panel toggle alone, beside a thread view whose details panel is its own. */
  readonly rightPanelControl: ReactNode;
  /** The decisions, in the lane above the composer. */
  readonly decisions: ReactNode;
  /** The task's badges. `openDetails` opens the details of the view they sit in. */
  readonly renderBadges: (openDetails: () => void, wrap: boolean) => ReactNode;
  /** The header has no room for the badges, so they take a row of their own under it. */
  readonly narrow: boolean;
  /** Opens the details sheet, which holds the task's details where no thread view stands. */
  readonly showDetails: () => void;
}

type Back = NonNullable<ChatViewSlots["parent"]>;

/** The native details card of the thread on screen, opened at the Task item in either form it takes. */
function openThreadDetails(thread: ScopedThreadRef) {
  const store = useRightPanelStore.getState();
  store.setThreadPanelOpen(thread, "inline", true);
  store.setThreadPanelOpen(thread, "popover", true);
  requestAnimationFrame(() =>
    document
      .querySelector("[data-thread-details-card] [data-thread-details-task]")
      ?.scrollIntoView({ block: "start" }),
  );
}

/** The badges in the header's actions when it has room, else in a row under the header. */
function badgePlaces(chrome: TaskChrome, openDetails: () => void) {
  return chrome.narrow
    ? {
        actions: chrome.actions,
        row: (
          <div
            className="flex shrink-0 items-center border-b border-border px-2 py-1"
            data-task-badges-row
          >
            {chrome.renderBadges(openDetails, true)}
          </div>
        ),
      }
    : {
        actions: (
          <>
            {chrome.renderBadges(openDetails, false)}
            {chrome.actions}
          </>
        ),
        row: null,
      };
}

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

/** Worked on another machine: its words stay, and nothing here mounts or sends to its thread. */
function ConversationElsewhere(props: { readonly task: TaskView }) {
  const gt = useGT();
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
      data-task-conversation="moved"
    >
      <TaskText task={props.task} />
      <p className="text-xs text-muted-foreground" role="status">
        {gt("This task is worked on another machine, or is on its way there.")}
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

/** Whose conversation is open in the centre, beside the task's panel toggles. */
function SeatLabel(props: { readonly seatName: string | null }) {
  const gt = useGT();
  return (
    <span
      className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
      data-task-seat-bar
    >
      <CornerDownRightIcon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">
        {props.seatName ? gt("Seat {seat}", { seat: props.seatName }) : gt("Seat conversation")}
      </span>
    </span>
  );
}

/** The row under the header with the task's own panel toggles, until the thread's panels host it. */
function TaskBar(props: { readonly controls: ReactNode; readonly children?: ReactNode }) {
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1"
      data-task-bar
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{props.children}</div>
      {props.controls}
    </div>
  );
}

/** The decisions, and for a closed task why nothing more can be written. */
function Lane(props: {
  readonly closed: boolean;
  readonly decisions: ReactNode;
  readonly className: string;
}) {
  const gt = useGT();
  return (
    <div className={cn("flex flex-col gap-2 empty:hidden", props.className)} data-task-lane-slot>
      {props.closed ? (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
          data-task-closed
        >
          {gt("This is closed. What was said is kept.")}
        </p>
      ) : null}
      {props.decisions}
    </div>
  );
}

/**
 * The native page for the task when no thread view stands in the centre: the same header title
 * and actions, the notices, the task's toggles, and the decisions at the foot.
 */
function TaskPage(props: {
  readonly title: string;
  readonly back?: Back | undefined;
  readonly actions: ReactNode;
  readonly banner: ReactNode;
  readonly lane: ReactNode;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-task-page>
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel={gt("Thread breadcrumb")} className="min-w-0 flex-1">
          {props.back ? (
            <>
              <WorkspaceBreadcrumbItem>
                <button
                  type="button"
                  onClick={props.back.open}
                  className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <WorkspaceBreadcrumbText>{props.back.title}</WorkspaceBreadcrumbText>
                </button>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator>
                <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbSeparator>
            </>
          ) : null}
          <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
            <h2 className="min-w-0">
              <WorkspaceBreadcrumbText>{props.title}</WorkspaceBreadcrumbText>
            </h2>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        {props.actions}
      </WorkspacePageHeader>
      {props.banner}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{props.children}</div>
      <div className="shrink-0 pb-safe">{props.lane}</div>
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
 * The task's conversation as the native thread view, its composer included, with the task's
 * title and actions in its header. A seat's conversation replaces it, and its parent breadcrumb
 * leads back to the task. Until the lead's conversation carries what the engine still says in its
 * log, the log stays one toggle away: it is where a question waits and where a proposal is answered.
 */
function OpenConversation(props: {
  readonly task: TaskView;
  readonly thread: ScopedThreadRef;
  readonly offline: boolean;
  readonly seat: SeatThread | null;
  readonly seatResolving: boolean;
  readonly seatName: string | null;
  readonly source: ScopedThreadRef | null;
  readonly onOpenThread: (thread: ScopedThreadRef) => void;
  readonly onBackToTask: () => void;
  readonly log: ReactNode;
  readonly chrome: TaskChrome;
  readonly closed: boolean;
}) {
  const gt = useGT();
  const { chrome } = props;
  const [view, setView] = useState<"conversation" | "log">("conversation");
  const [attempt, setAttempt] = useState(0);
  const shown = props.seat ?? props.thread;
  const inSeat = props.seat !== null || props.seatResolving;
  // The conversation the task was filed from opens here as a seat does, but is no seat.
  const sourceOpen = props.seat !== null && sameThread(props.seat, props.source);
  const back: Back = {
    title: gt("Back to task #{number}", { number: props.task.number }),
    open: props.onBackToTask,
  };
  const seatTitle = props.seatName
    ? gt("Seat {seat}", { seat: props.seatName })
    : gt("Seat conversation");
  // The thread view's details are its own panel's; a page's are the sheet.
  const threadPlaces = badgePlaces(chrome, () => openThreadDetails(shown));
  const pagePlaces = badgePlaces(chrome, chrome.showDetails);
  // A seat's thread view titles itself, so the bar names the seat; a page titles it instead.
  const banner = (threadView: boolean) => (
    <>
      {chrome.notices}
      {(threadView ? threadPlaces : pagePlaces).row}
      <TaskBar controls={threadView ? chrome.rightPanelControl : chrome.panelControls}>
        {inSeat ? (
          threadView && !sourceOpen ? (
            <SeatLabel seatName={props.seatName} />
          ) : null
        ) : (
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
        )}
      </TaskBar>
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
    </>
  );
  // Where no thread view stands, the page carries the same header, banner and lane.
  const page = (content: ReactNode) => (
    <TaskPage
      title={inSeat ? (sourceOpen ? gt("Conversation") : seatTitle) : chrome.title}
      back={inSeat ? back : undefined}
      actions={pagePlaces.actions}
      banner={banner(false)}
      lane={<Lane closed={props.closed} decisions={chrome.decisions} className="px-3 pb-3" />}
    >
      {content}
    </TaskPage>
  );
  const loading = (
    <p role="status" className="p-4 text-sm text-muted-foreground">
      {gt("Loading the conversation...")}
    </p>
  );
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-task-conversation={inSeat ? "seat" : "open"}
    >
      {props.seat === null && props.seatResolving ? (
        // The seat is open but its links are not known yet. The task's own conversation is not
        // shown in its place, and neither view is mounted only to be swapped for the other.
        page(loading)
      ) : view === "log" && !inSeat ? (
        page(props.log)
      ) : (
        <ThreadInspectionContext value={props.onOpenThread}>
          <RenderErrorBoundary
            resetKeys={[attempt, shown.threadId]}
            fallback={page(
              <ConversationFailed attempt={attempt} onRetry={() => setAttempt((n) => n + 1)} />,
            )}
          >
            <Suspense fallback={page(loading)}>
              {props.seat?.linked ? (
                page(<LinkedSeat seat={props.seat} linked={props.seat.linked} />)
              ) : (
                <ChatView
                  key={`${shown.environmentId}:${shown.threadId}`}
                  environmentId={shown.environmentId}
                  threadId={shown.threadId}
                  routeKind="server"
                  unavailableContent={page(
                    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
                      <TaskText task={props.task} />
                      <p role="status" className="text-xs text-muted-foreground">
                        {gt(
                          "This conversation is loading or is not available here. The task's facts beside it stand.",
                        )}
                      </p>
                    </div>,
                  )}
                  slots={{
                    ...(inSeat ? { parent: back } : { title: chrome.title }),
                    headerActions: threadPlaces.actions,
                    banner: banner(true),
                    composerLane: (
                      <Lane closed={props.closed} decisions={chrome.decisions} className="pb-2" />
                    ),
                    composer: !props.closed,
                  }}
                />
              )}
            </Suspense>
          </RenderErrorBoundary>
        </ThreadInspectionContext>
      )}
    </div>
  );
}

/**
 * The centre of the task view (BOARD-REVAMP-UI-SPEC section 6): the native thread view when the
 * task has one, else the native page with the task's words. Which conversation, and whether T3 can
 * serve it, are decided by `lib/taskConversation`; this only draws each case.
 */
export function TaskConversation(props: {
  readonly task: TaskView;
  readonly state: ConversationState;
  readonly seat: SeatThread | null;
  /** A seat is open but cannot be placed yet. */
  readonly seatResolving: boolean;
  readonly seatName: string | null;
  /** The conversation the task was filed from, which can be opened here too. */
  readonly source: ScopedThreadRef | null;
  readonly onOpenThread: (thread: ScopedThreadRef) => void;
  readonly onBackToTask: () => void;
  /** The engine's own log and its composer, for a task whose conversation is not known yet. */
  readonly log: ReactNode;
  readonly chrome: TaskChrome;
}) {
  const gt = useGT();
  const { state, task, chrome } = props;
  // A closed or rejected task keeps what was said, and nothing more is written to it.
  const closed = task.state === "rejected" || task.state === "closed";
  const places = badgePlaces(chrome, chrome.showDetails);
  const page = (content: ReactNode) => (
    <TaskPage
      title={chrome.title}
      actions={places.actions}
      banner={
        <>
          {chrome.notices}
          {places.row}
          <TaskBar controls={chrome.panelControls} />
        </>
      }
      lane={<Lane closed={closed} decisions={chrome.decisions} className="px-3 pb-3" />}
    >
      {content}
    </TaskPage>
  );
  switch (state.kind) {
    case "waiting":
      return page(<ConversationWaiting task={task} why={state.why} />);
    case "moved":
      return page(<ConversationElsewhere task={task} />);
    case "unlinked":
      return page(
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-task-conversation="unlinked">
          <p className="shrink-0 border-b border-border px-3 py-1.5 text-2xs text-muted-foreground">
            {gt(
              "No conversation is linked to this task yet. The engine's log stands in until one is.",
            )}
          </p>
          <div className="shrink-0 border-b border-border p-4">
            <TaskText task={task} />
          </div>
          {props.log}
        </div>,
      );
    case "open":
      return (
        <OpenConversation
          task={task}
          thread={state.ref}
          offline={state.offline}
          seat={props.seat}
          seatResolving={props.seatResolving}
          seatName={props.seatName}
          source={props.source}
          onOpenThread={props.onOpenThread}
          onBackToTask={props.onBackToTask}
          log={props.log}
          chrome={chrome}
          closed={closed}
        />
      );
  }
}
