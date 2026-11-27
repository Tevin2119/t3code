import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ArrowLeftIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import type { TaskView } from "../../lib/delivery";
import { queueWait, type ConversationState } from "../../lib/taskConversation";
import { useRightPanelStore } from "../../rightPanelStore";
import { ThreadPanelHostContext } from "../chat/ThreadPanelHostContext";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { QueueLine } from "./BoardLaneCards";

const ChatView = lazy(() => import("../ChatView"));

/** What the task view puts around its centre, in every state. */
export interface TaskChrome {
  /** The header's one action: the task's menu. */
  readonly actions: ReactNode;
  /** Lines under the header: the engine's notices and the last refusal. */
  readonly notices: ReactNode;
  /** The native panel toggles on a page; none with a thread, whose view has its own. */
  readonly panelControls: ReactNode;
  /** Takes the page header a page's details card hangs from. */
  readonly panelAnchor?: ((element: HTMLDivElement | null) => void) | undefined;
  /** Opens the native details card at the engine's log, for a page with no thread. */
  readonly showLog: () => void;
  /** Takes a message the task no longer takes as a turn; true when the engine took it. */
  readonly steer?: ((text: string) => Promise<boolean>) | undefined;
  /** Back to the board, for a phone, where the board's column is a sheet behind the trigger. */
  readonly backToBoard: () => void;
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

/**
 * The row under the header below the width where the board's column becomes a sheet: the way back
 * to the board. The header keeps everything else, as any thread's does.
 */
function TaskBar(props: { readonly onBack: () => void }) {
  const gt = useGT();
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 md:hidden"
      data-task-bar
    >
      <span className="flex shrink-0" data-task-back-to-board>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={gt("Back to board")}
          onClick={props.onBack}
        >
          <ArrowLeftIcon />
        </Button>
      </span>
    </div>
  );
}

/**
 * What a finished task with no thread takes in place of a thread's composer: the words go to the
 * engine, which refuses or takes them; refused, they stay to be sent again.
 */
function SteerComposer(props: { readonly steer: (text: string) => Promise<boolean> }) {
  const gt = useGT();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    const taken = await props.steer(message);
    setSending(false);
    if (taken) setText("");
  };
  return (
    <form
      className="flex shrink-0 items-end gap-2 border-t border-border p-3"
      data-task-steer-composer
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="min-w-0 flex-1">
        <Textarea
          aria-label={gt("Message this task")}
          size="sm"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void send();
          }}
        />
      </div>
      <Button type="submit" size="sm" disabled={sending || text.trim() === ""}>
        {gt("Send", { $context: "verb, sends a message" })}
      </Button>
    </form>
  );
}

/**
 * The native page for the task when no thread view stands in the centre: the task's title, its
 * menu and the native panel toggles in the header, and the notices under it.
 */
function TaskPage({
  anchor,
  ...props
}: {
  readonly title: string;
  readonly actions: ReactNode;
  readonly controls: ReactNode;
  readonly anchor?: ((element: HTMLDivElement | null) => void) | undefined;
  readonly banner: ReactNode;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-task-page>
      <div ref={anchor} className="shrink-0">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel={gt("Thread breadcrumb")} className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
              <h2 className="min-w-0">
                <WorkspaceBreadcrumbText>{props.title}</WorkspaceBreadcrumbText>
              </h2>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          {props.actions}
          {props.controls}
        </WorkspacePageHeader>
      </div>
      {props.banner}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col pb-safe">{props.children}</div>
    </div>
  );
}

/**
 * The task's conversation as the native thread view, composer included, titled by the thread
 * itself with the task's menu in its header. Its panels are the task thread's own: the right
 * panel with the task's tabs, and the details card with the Task item and the task's lineage.
 */
function OpenConversation(props: {
  readonly task: TaskView;
  readonly thread: ScopedThreadRef;
  readonly offline: boolean;
  readonly chrome: TaskChrome;
}) {
  const gt = useGT();
  const { chrome } = props;
  const [attempt, setAttempt] = useState(0);
  const banner = (
    <>
      {chrome.notices}
      <TaskBar onBack={chrome.backToBoard} />
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
  // Where no thread view stands, the page carries the same header and banner.
  const page = (content: ReactNode) => (
    <TaskPage title={props.task.title} actions={chrome.actions} controls={null} banner={banner}>
      {content}
    </TaskPage>
  );
  const loading = (
    <p role="status" className="p-4 text-sm text-muted-foreground">
      {gt("Loading the conversation...")}
    </p>
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-task-conversation="open">
      <ThreadPanelHostContext value={props.thread}>
        <RenderErrorBoundary
          resetKeys={[attempt, props.thread.threadId]}
          fallback={page(
            <ConversationFailed attempt={attempt} onRetry={() => setAttempt((n) => n + 1)} />,
          )}
        >
          <Suspense fallback={page(loading)}>
            <ChatView
              key={`${props.thread.environmentId}:${props.thread.threadId}`}
              environmentId={props.thread.environmentId}
              threadId={props.thread.threadId}
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
                headerActions: chrome.actions,
                banner,
                ...(chrome.steer ? { sendInstead: chrome.steer } : {}),
                // The + menu adds the one tab it names, so a closed tab always comes back.
                onAddTaskSurface: (kind) => useRightPanelStore.getState().open(props.thread, kind),
              }}
            />
          </Suspense>
        </RenderErrorBoundary>
      </ThreadPanelHostContext>
    </div>
  );
}

/**
 * The centre of the task view (BOARD-REVAMP-UI-SPEC section 6): the native thread view when the
 * task has one, else the native page with the task's words, or for a draft its editor. Which
 * conversation, and whether T3 can serve it, are decided by `lib/taskConversation`; this only
 * draws each case.
 */
export function TaskConversation(props: {
  readonly task: TaskView;
  readonly state: ConversationState;
  /** The task editor, which is a draft's centre. Its own controls submit and discard it. */
  readonly draft?: ReactNode;
  readonly chrome: TaskChrome;
}) {
  const gt = useGT();
  const { state, task, chrome } = props;
  // A finished task with no thread still takes words, so its engine can say why it will not act.
  const steerComposer =
    chrome.steer && !props.draft ? <SteerComposer steer={chrome.steer} /> : null;
  const page = (content: ReactNode) => (
    <TaskPage
      title={task.title}
      actions={chrome.actions}
      controls={chrome.panelControls}
      anchor={chrome.panelAnchor}
      banner={
        <>
          {chrome.notices}
          <TaskBar onBack={chrome.backToBoard} />
        </>
      }
    >
      {content}
      {steerComposer}
    </TaskPage>
  );
  if (props.draft) return page(props.draft);
  switch (state.kind) {
    case "waiting":
      return page(<ConversationWaiting task={task} why={state.why} />);
    case "moved":
      return page(<ConversationElsewhere task={task} />);
    case "unlinked":
      return page(
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
          data-task-conversation="unlinked"
        >
          <TaskText task={task} />
          <p className="text-xs text-muted-foreground" role="status">
            {gt(
              "No conversation is linked to this task yet. The engine's log stands in until one is.",
            )}{" "}
            <button
              type="button"
              className="cursor-pointer text-primary underline-offset-2 hover:underline"
              onClick={chrome.showLog}
              data-task-open-log
            >
              {gt("Open the engine log")}
            </button>
          </p>
        </div>,
      );
    case "open":
      return (
        <OpenConversation task={task} thread={state.ref} offline={state.offline} chrome={chrome} />
      );
  }
}
