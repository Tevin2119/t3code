import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, fakeTimers, render } from "../../../test/render";
import { parseTask } from "../../lib/delivery";
import type { SeatThread } from "../../lib/taskConversation";
import { useThreadInspection } from "../chat/ThreadInspectionContext";
import { TaskConversation } from "./TaskConversation";
import { SEAT_LINKED_VIEW_DELAY_MS, useSteadySeat } from "./useTaskConversation";

/** Every thread the direct view was mounted for, in order. */
const mountedThreads: string[] = [];

vi.mock("../ChatView", () => ({
  default: ({ threadId }: { threadId: string }) => {
    const inspect = useThreadInspection();
    useEffect(() => {
      mountedThreads.push(threadId);
    }, [threadId]);
    return (
      <div>
        <p>Thread view {threadId}</p>
        <textarea aria-label="Composer" />
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

const idle = {
  seat: null,
  seatResolving: false,
  seatName: null,
  onOpenThread: () => {},
  onBackToTask: () => {},
  log: <p>The engine log</p>,
};

it("shows a queued task's text and the engine's place, with nothing to type into", async () => {
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
  await expect.element(screen.getByText("Make the sync stop dropping rows.")).toBeVisible();
  await expect.element(screen.getByText(/4 of 4 slots busy/)).toBeVisible();
  await expect.element(screen.getByText("#9 Holds one")).toBeVisible();
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
});

it("opens the thread in the centre, with the engine log one toggle away", async () => {
  await using screen = await render(
    <TaskConversation {...idle} task={task()} state={{ kind: "open", ref, offline: false }} />,
  );
  await expect.element(screen.getByText("Thread view lead-thread")).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Composer" })).toBeVisible();
  await page.getByRole("button", { name: "Engine log" }).click();
  await expect.element(screen.getByText("The engine log")).toBeVisible();
  await expect.element(screen.getByText("Thread view lead-thread")).not.toBeInTheDocument();
});

it("hands a thread the conversation opens to the view, and offers the way back from a seat", async () => {
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
    await screen.rerender(<Seat resolved={linked} reach={loaded} />);
    await expect.element(screen.getByText("Linked view of seat-thread")).toBeVisible();
    expect(mountedThreads).toEqual([]);
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
