import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { page } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { parseTask } from "../../lib/delivery";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import type { ChatViewSlots } from "../ChatView";
import { useThreadPanelHost } from "../chat/ThreadPanelHostContext";
import { TaskConversation } from "./TaskConversation";

/** Every thread the direct view was mounted for, in order. */
const mountedThreads: string[] = [];

// The native thread view, drawing what the task view hands its header, banner and panels.
vi.mock("../ChatView", () => ({
  default: ({ threadId, slots }: { threadId: string; slots?: ChatViewSlots }) => {
    const panelHost = useThreadPanelHost();
    const [text, setText] = useState("");
    useEffect(() => {
      mountedThreads.push(threadId);
    }, [threadId]);
    return (
      <div>
        <header>
          <h2>{slots?.title ?? `Thread title ${threadId}`}</h2>
          {slots?.headerActions}
        </header>
        {slots?.banner}
        <p>Thread view {threadId}</p>
        <p>Panels of {panelHost?.threadId ?? threadId}</p>
        {slots?.onAddTaskSurface ? (
          <button onClick={() => slots.onAddTaskSurface?.("task-evidence")}>
            Add task evidence
          </button>
        ) : null}
        {slots?.composerLane}
        {slots?.composer === false ? null : (
          <>
            <textarea
              aria-label="Composer"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <button
              onClick={() => void slots?.sendInstead?.(text).then((taken) => taken && setText(""))}
            >
              Send
            </button>
          </>
        )}
      </div>
    );
  },
}));

const ref = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("lead-thread") };

const task = (extra: Record<string, unknown> = {}) => {
  const view = parseTask({
    id: "t1",
    number: 12,
    title: "Fix the sync",
    body: "Make the sync stop dropping rows.",
    state: "ready",
    lane: "ready",
    card: { id: "t1", number: 12, title: "Fix the sync", lane: "ready", submitted: "2026-11-21" },
    ...extra,
  });
  if (!view) throw new Error("the fixture did not parse");
  return view;
};

const chrome = {
  actions: <button>Task menu</button>,
  notices: <p>Engine notice</p>,
  panelControls: <button>Native toggles</button>,
  showLog: () => {},
  backToBoard: () => {},
};

it("shows a queued task's text and the engine's place in the native page, with nothing to type into", async () => {
  await using screen = await render(
    <TaskConversation
      chrome={chrome}
      task={task({
        card: {
          id: "t1",
          number: 12,
          title: "Fix the sync",
          lane: "ready",
          submitted: "2026-11-21",
          queue: {
            position: 3,
            cap: 4,
            busy: 4,
            holders: [{ id: "h", number: 9, title: "Holds one" }],
          },
        },
      })}
      state={{ kind: "waiting", why: "queued" }}
    />,
  );
  // The card's title, as a thread's; the number is the Task item's.
  expect(screen.container.querySelector("header h2")?.textContent).toBe("Fix the sync");
  await expect.element(screen.getByRole("button", { name: "Task menu" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Native toggles" })).toBeVisible();
  await expect.element(screen.getByText("Engine notice")).toBeVisible();
  await expect.element(screen.getByText("Make the sync stop dropping rows.")).toBeVisible();
  await expect.element(screen.getByText(/4 of 4 slots busy/)).toBeVisible();
  await expect.element(screen.getByText("#9 Holds one")).toBeVisible();
  await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
});

it("opens a draft's editor as the centre of the task's page, which leaves submitting to it", async () => {
  await using screen = await render(
    <TaskConversation
      chrome={chrome}
      task={task({ state: "draft", lane: "draft" })}
      state={{ kind: "waiting", why: "draft" }}
      draft={<p>The task editor</p>}
    />,
  );
  await expect.element(screen.getByText("The task editor")).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Fix the sync" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Task menu" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Native toggles" })).toBeVisible();
});

it("keeps the thread mounted and says the conversation resumes when T3 is back", async () => {
  await using screen = await render(
    <TaskConversation chrome={chrome} task={task()} state={{ kind: "open", ref, offline: true }} />,
  );
  await expect.element(screen.getByText(/It resumes when T3 is back/)).toBeVisible();
  await expect.element(screen.getByText("Thread view lead-thread")).toBeVisible();
});

it("points a task in work with no conversation known at the engine's log in its details", async () => {
  const showLog = vi.fn();
  await using screen = await render(
    <TaskConversation chrome={{ ...chrome, showLog }} task={task()} state={{ kind: "unlinked" }} />,
  );
  await expect.element(screen.getByText(/No conversation is linked/)).toBeVisible();
  await expect.element(screen.getByText("Make the sync stop dropping rows.")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Native toggles" })).toBeVisible();
  await screen.getByRole("button", { name: "Open the engine log" }).click();
  expect(showLog).toHaveBeenCalledOnce();
});

it("says a task worked on another machine is there, and mounts no thread for it", async () => {
  mountedThreads.length = 0;
  await using screen = await render(
    <TaskConversation chrome={chrome} task={task({ state: "moved" })} state={{ kind: "moved" }} />,
  );
  await expect.element(screen.getByText(/worked on another machine/)).toBeVisible();
  await expect.element(screen.getByText("Make the sync stop dropping rows.")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Task menu" })).toBeVisible();
  await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
  expect(mountedThreads).toEqual([]);
});

it("opens the thread as the plain native view: its own title, the task's menu, its own panels", async () => {
  useRightPanelStore.setState(useRightPanelStore.getInitialState());
  await using screen = await render(
    <TaskConversation
      chrome={chrome}
      task={task()}
      state={{ kind: "open", ref, offline: false }}
    />,
  );
  await expect.element(screen.getByText("Thread view lead-thread")).toBeVisible();
  await expect
    .element(screen.getByRole("heading", { name: "Thread title lead-thread" }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Task menu" })).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Composer" })).toBeVisible();
  // No task chrome: the view's own toggles and details are the only ones.
  await expect.element(screen.getByRole("heading", { name: /#12/ })).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Native toggles" }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText("Panels of lead-thread")).toBeVisible();
  // Nothing opened unasked; the + menu adds the one tab it names, on the task thread's panel.
  expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).isOpen).toBe(
    false,
  );
  await screen.getByRole("button", { name: "Add task evidence" }).click();
  expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref)).toMatchObject(
    {
      isOpen: true,
      surfaces: [{ id: "task-evidence", kind: "task-evidence" }],
    },
  );
});

it("keeps a closed task's composer, and hands what is written to the engine instead of a turn", async () => {
  const steer = vi.fn(async (text: string) => text !== "refused");
  await using screen = await render(
    <TaskConversation
      chrome={{ ...chrome, steer }}
      task={task({ state: "closed" })}
      state={{ kind: "open", ref, offline: false }}
    />,
  );
  const composer = screen.getByRole("textbox", { name: "Composer" });
  await expect.element(composer).toBeVisible();
  // Refused: the words stay for another try.
  await composer.fill("refused");
  await screen.getByRole("button", { name: "Send" }).click();
  expect(steer).toHaveBeenLastCalledWith("refused");
  await expect.element(composer).toHaveValue("refused");
  await composer.fill("taken");
  await screen.getByRole("button", { name: "Send" }).click();
  expect(steer).toHaveBeenLastCalledWith("taken");
  await expect.element(composer).toHaveValue("");
});

it("leads back to the board from a phone, over the thread view and a page alike", async () => {
  await page.viewport(400, 800);
  const backToBoard = vi.fn();
  await using screen = await render(
    <TaskConversation
      chrome={{ ...chrome, backToBoard }}
      task={task()}
      state={{ kind: "open", ref, offline: false }}
    />,
  );
  await screen.getByRole("button", { name: "Back to board" }).click();
  await screen.rerender(
    <TaskConversation
      chrome={{ ...chrome, backToBoard }}
      task={task()}
      state={{ kind: "unlinked" }}
    />,
  );
  await screen.getByRole("button", { name: "Back to board" }).click();
  expect(backToBoard).toHaveBeenCalledTimes(2);
});
