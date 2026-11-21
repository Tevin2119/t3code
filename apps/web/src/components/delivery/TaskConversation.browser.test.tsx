import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { parseTask } from "../../lib/delivery";
import { useThreadInspection } from "../chat/ThreadInspectionContext";
import { TaskConversation } from "./TaskConversation";

vi.mock("../ChatView", () => ({
  default: ({ threadId }: { threadId: string }) => {
    const inspect = useThreadInspection();
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
