import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, fakeTimers, render } from "../../../test/render";
import { parseTask } from "../../lib/delivery";
import type { SeatThread } from "../../lib/taskConversation";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import type { ChatViewSlots } from "../ChatView";
import { useThreadInspection } from "../chat/ThreadInspectionContext";
import { TaskConversation } from "./TaskConversation";
import { SEAT_LINKED_VIEW_DELAY_MS, useSteadySeat } from "./useTaskConversation";

/** Every thread the direct view was mounted for, in order. */
const mountedThreads: string[] = [];

// The native thread view, drawing what the task view hands its header, banner and lanes.
vi.mock("../ChatView", () => ({
  default: ({ threadId, slots }: { threadId: string; slots?: ChatViewSlots }) => {
    const inspect = useThreadInspection();
    useEffect(() => {
      mountedThreads.push(threadId);
    }, [threadId]);
    return (
      <div>
        <header>
          {slots?.parent ? <button onClick={slots.parent.open}>{slots.parent.title}</button> : null}
          <h2>{slots?.title ?? `Thread title ${threadId}`}</h2>
          {slots?.headerActions}
        </header>
        {slots?.banner}
        <p>Thread view {threadId}</p>
        {slots?.composerLane}
        {slots?.composer === false ? null : <textarea aria-label="Composer" />}
        <button
          onClick={() =>
            inspect?.({
              environmentId: EnvironmentId.make("env-1"),
              threadId: ThreadId.make("child-thread"),
            })
          }
        >
          Open child
        </button>
      </div>
    );
  },
}));

// The read-only view of a linked environment's thread, which reads over the task's connection.
vi.mock("../chat/LinkedThreadPane", () => ({
  LinkedThread: ({ surface }: { surface: { threadId: string } }) => (
    <p>Linked view of {surface.threadId}</p>
  ),
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
  title: "#12 Fix the sync",
  actions: <button>Task menu</button>,
  notices: <p>Engine notice</p>,
  panelControls: <button>Task panels</button>,
  rightPanelControl: <button>Task right panel</button>,
  decisions: <p>Your decision</p>,
  renderBadges: (openDetails: () => void) => <button onClick={openDetails}>Task badges</button>,
  narrow: false,
  showDetails: () => {},
  backToBoard: () => {},
};

const idle = {
  seat: null,
  seatResolving: false,
  seatName: null,
  source: null,
  onOpenThread: () => {},
  onBackToTask: () => {},
  log: <p>The engine log</p>,
  chrome,
};

it("shows a queued task's text and the engine's place in the native page, with nothing to type into", async () => {
  await using screen = await render(
    <TaskConversation
      {...idle}
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
  await expect.element(screen.getByRole("heading", { name: "#12 Fix the sync" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Task menu" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Task panels" })).toBeVisible();
  await expect.element(screen.getByText("Engine notice")).toBeVisible();
  await expect.element(screen.getByText("Make the sync stop dropping rows.")).toBeVisible();
  await expect.element(screen.getByText(/4 of 4 slots busy/)).toBeVisible();
  await expect.element(screen.getByText("#9 Holds one")).toBeVisible();
  await expect.element(screen.getByText("Your decision")).toBeVisible();
  await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
});

it("keeps the thread mounted and says the conversation resumes when T3 is back", async () => {
  await using screen = await render(
    <TaskConversation {...idle} task={task()} state={{ kind: "open", ref, offline: true }} />,
  );
  await expect.element(screen.getByText(/It resumes when T3 is back/)).toBeVisible();
  await expect.element(screen.getByText("Thread view lead-thread")).toBeVisible();
});

it("keeps the engine's log, with its composer, for a task in work with no conversation known", async () => {
  await using screen = await render(
    <TaskConversation {...idle} task={task()} state={{ kind: "unlinked" }} />,
  );
  await expect.element(screen.getByText("The engine log")).toBeVisible();
  await expect.element(screen.getByText(/No conversation is linked/)).toBeVisible();
  await expect.element(screen.getByText("Make the sync stop dropping rows.")).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "#12 Fix the sync" })).toBeVisible();
});

it("says a task worked on another machine is there, and mounts no thread for it", async () => {
  mountedThreads.length = 0;
  await using screen = await render(
    <TaskConversation {...idle} task={task({ state: "moved" })} state={{ kind: "moved" }} />,
  );
  await expect.element(screen.getByText(/worked on another machine/)).toBeVisible();
  await expect.element(screen.getByText("Make the sync stop dropping rows.")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Task menu" })).toBeVisible();
  await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
  expect(mountedThreads).toEqual([]);
});

it("opens the thread as the native view, titled by the task, with the engine log one toggle away", async () => {
  await using screen = await render(
    <TaskConversation {...idle} task={task()} state={{ kind: "open", ref, offline: false }} />,
  );
  await expect.element(screen.getByText("Thread view lead-thread")).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "#12 Fix the sync" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Task menu" })).toBeVisible();
  await expect.element(screen.getByText("Your decision")).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Composer" })).toBeVisible();
  // The thread view's own details panel holds the task's details, so only the right panel's is here.
  await expect.element(screen.getByRole("button", { name: "Task right panel" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Task panels" })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Engine log" }).click();
  await expect.element(screen.getByText("The engine log")).toBeVisible();
  await expect.element(screen.getByText("Thread view lead-thread")).not.toBeInTheDocument();
  // The page that stands in keeps the task's header, actions and toggles.
  await expect.element(screen.getByRole("heading", { name: "#12 Fix the sync" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Task menu" })).toBeVisible();
  await page.getByRole("button", { name: "Conversation" }).click();
  await expect.element(screen.getByText("Thread view lead-thread")).toBeVisible();
});

it("puts the badges in the header when it has room, else in a row under it, opening the details where the view keeps them", async () => {
  useRightPanelStore.setState(useRightPanelStore.getInitialState());
  const showDetails = vi.fn();
  const queued = { kind: "waiting", why: "queued" } as const;
  const open = { kind: "open", ref, offline: false } as const;
  await using screen = await render(
    <TaskConversation {...idle} chrome={{ ...chrome, showDetails }} task={task()} state={queued} />,
  );
  const badges = screen.getByRole("button", { name: "Task badges" });
  const inRow = () => badges.element().closest("[data-task-badges-row]") !== null;
  await expect.element(badges).toBeVisible();
  expect(inRow()).toBe(false);
  // A page has no thread view: its details are the sheet.
  await badges.click();
  expect(showDetails).toHaveBeenCalledOnce();

  // A thread view: the badges sit in its header and open its own details panel.
  await screen.rerender(
    <TaskConversation {...idle} chrome={{ ...chrome, showDetails }} task={task()} state={open} />,
  );
  expect(badges.element().closest("header")).not.toBeNull();
  await badges.click();
  const { threadPanelVisibilityByThreadKey } = useRightPanelStore.getState();
  expect(selectThreadPanelOpen(threadPanelVisibilityByThreadKey, ref, "inline")).toBe(true);
  expect(showDetails).toHaveBeenCalledOnce();

  // Narrow: the badges leave the header for a row of their own under it.
  await screen.rerender(
    <TaskConversation {...idle} chrome={{ ...chrome, narrow: true }} task={task()} state={open} />,
  );
  await expect.element(badges).toBeVisible();
  expect(inRow()).toBe(true);
  expect(badges.element().closest("header")).toBeNull();
});

it("keeps a closed task's thread to read, with no composer", async () => {
  await using screen = await render(
    <TaskConversation
      {...idle}
      task={task({ state: "closed" })}
      state={{ kind: "open", ref, offline: false }}
    />,
  );
  await expect.element(screen.getByText("Thread view lead-thread")).toBeVisible();
  await expect.element(screen.getByText("This is closed. What was said is kept.")).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Composer" })).not.toBeInTheDocument();
});

it("hands a thread the conversation opens to the view, and leads back from a seat by the breadcrumb", async () => {
  const onOpenThread = vi.fn();
  const onBackToTask = vi.fn();
  await using screen = await render(
    <TaskConversation
      {...idle}
      task={task()}
      state={{ kind: "open", ref, offline: false }}
      onOpenThread={onOpenThread}
    />,
  );
  await page.getByRole("button", { name: "Open child" }).click();
  expect(onOpenThread).toHaveBeenCalledWith({
    environmentId: "env-1",
    threadId: "child-thread",
  });
  await screen.rerender(
    <TaskConversation
      {...idle}
      task={task()}
      state={{ kind: "open", ref, offline: false }}
      seat={{ environmentId: ref.environmentId, threadId: ThreadId.make("child-thread") }}
      seatName="qa"
      onBackToTask={onBackToTask}
    />,
  );
  await expect.element(screen.getByText("Thread view child-thread")).toBeVisible();
  await expect.element(screen.getByText("Seat qa")).toBeVisible();
  // The seat's own thread keeps its title; the task's actions stay in reach.
  await expect
    .element(screen.getByRole("heading", { name: "Thread title child-thread" }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Task menu" })).toBeVisible();
  await page.getByRole("button", { name: "Back to task #12" }).click();
  expect(onBackToTask).toHaveBeenCalledOnce();
});

it("opens the conversation the task was filed from in the centre, with the way back and no seat label", async () => {
  const source = {
    environmentId: EnvironmentId.make("env-9"),
    threadId: ThreadId.make("filed-from"),
  };
  const onBackToTask = vi.fn();
  await using screen = await render(
    <TaskConversation
      {...idle}
      task={task()}
      state={{ kind: "open", ref, offline: false }}
      seat={source}
      source={source}
      onBackToTask={onBackToTask}
    />,
  );
  await expect.element(screen.getByText("Thread view filed-from")).toBeVisible();
  await expect.element(screen.getByText("Seat conversation")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Back to task #12" }).click();
  expect(onBackToTask).toHaveBeenCalledOnce();
});

describe("a seat in a linked environment", () => {
  const remote = EnvironmentId.make("env-remote");
  const direct = { environmentId: remote, threadId: ThreadId.make("seat-thread") };
  const linked = { ...direct, linked: { viaEnvironmentId: ref.environmentId, label: "Desktop" } };
  const loading = { certain: false, connected: false };
  const loaded = { certain: true, connected: false };
  const online = { certain: true, connected: true };

  // The hook and the view together, as TaskWorkspace wires them.
  function Seat(props: {
    readonly resolved: SeatThread;
    readonly reach: { readonly certain: boolean; readonly connected: boolean };
  }) {
    const { seat, resolving } = useSteadySeat(props.resolved, props.reach);
    return (
      <TaskConversation
        {...idle}
        task={task()}
        state={{ kind: "open", ref, offline: false }}
        seat={seat}
        seatResolving={resolving}
        seatName="qa"
      />
    );
  }

  it("waits for the links before it mounts either view, and never shows the task's own thread", async () => {
    mountedThreads.length = 0;
    await using screen = await render(<Seat resolved={direct} reach={loading} />);
    await expect.element(screen.getByText("Seat qa")).toBeVisible();
    await expect.element(screen.getByText("Loading the conversation...")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Back to task #12" })).toBeVisible();
    await screen.rerender(<Seat resolved={linked} reach={loaded} />);
    await expect.element(screen.getByText("Linked view of seat-thread")).toBeVisible();
    expect(mountedThreads).toEqual([]);
  });

  it("stays in the direct view, composer and all, while a saved environment that nothing links to is offline", async () => {
    using _timers = fakeTimers();
    await using screen = await render(<Seat resolved={direct} reach={online} />);
    const composer = screen.getByRole("textbox", { name: "Composer" });
    await composer.fill("half a sentence");
    const element = composer.element();
    // Offline with no link: the links answer, and there is still nothing to read it through.
    for (const reach of [loading, loaded]) {
      await screen.rerender(<Seat resolved={direct} reach={reach} />);
      await act(() => vi.advanceTimersByTime(SEAT_LINKED_VIEW_DELAY_MS * 3));
      expect(element.isConnected).toBe(true);
      expect(document.activeElement).toBe(element);
    }
    // Back online: the same view, with what was typed.
    await screen.rerender(<Seat resolved={direct} reach={online} />);
    expect((element as HTMLTextAreaElement).value).toBe("half a sentence");
    expect(document.body.textContent).not.toContain("Linked view");
  });

  it("keeps the composer, its text and its focus through a reconnect, and moves to the linked view only when the connection stays down", async () => {
    // The hook's wait is a timer, held here until the test moves it.
    using _timers = fakeTimers();
    await using screen = await render(<Seat resolved={direct} reach={online} />);
    const composer = screen.getByRole("textbox", { name: "Composer" });
    await composer.fill("half a sentence");
    const element = composer.element();
    const untouched = () =>
      document.activeElement === element &&
      element.isConnected &&
      (element as HTMLTextAreaElement).value === "half a sentence";
    expect(untouched()).toBe(true);

    // The connection drops and the link answers: the linked view is only offered for later.
    await screen.rerender(<Seat resolved={linked} reach={loaded} />);
    await act(() => vi.advanceTimersByTime(SEAT_LINKED_VIEW_DELAY_MS - 1));
    expect(untouched()).toBe(true);
    // Back before the wait is over, and the wait does not carry into the next drop.
    await screen.rerender(<Seat resolved={direct} reach={online} />);
    await act(() => vi.advanceTimersByTime(SEAT_LINKED_VIEW_DELAY_MS));
    expect(untouched()).toBe(true);
    await screen.rerender(<Seat resolved={linked} reach={loaded} />);
    await act(() => vi.advanceTimersByTime(SEAT_LINKED_VIEW_DELAY_MS - 1));
    expect(untouched()).toBe(true);

    // It stays down: the read-only view through the link takes over.
    await act(() => vi.advanceTimersByTime(1));
    await expect.element(screen.getByText("Linked view of seat-thread")).toBeVisible();
    expect(element.isConnected).toBe(false);
    // Its own connection returns: the direct view is back at once.
    await screen.rerender(<Seat resolved={direct} reach={online} />);
    await expect.element(screen.getByText("Thread view seat-thread")).toBeVisible();
  });
});
