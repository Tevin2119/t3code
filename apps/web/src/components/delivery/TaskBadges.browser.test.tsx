import "~/index.css";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { parseTask } from "../../lib/delivery";
import { BoardTaskContext, type BoardTask } from "./BoardTaskContext";
import { TaskBadges } from "./TaskBadges";
import { TaskDetailsItem } from "./TaskDetails";
import { TaskRelatedWork } from "./TaskRelatedWork";

vi.mock(import("../../state/delivery"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePersonName: () => "Sam",
  useDeliveryAct: () => vi.fn(),
  useDeliveryRead: () =>
    ({ body: [], error: null, isPending: false, readAt: null, refresh: () => {} }) as never,
}));
vi.mock("./SeatSettingsPanel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SeatSettingsPanel")>()),
  useSeatCatalog: () => ({ entries: [], providers: [], options: {} }),
  SeatSettingsPanel: () => null,
}));
vi.mock("../ThreadHoverCard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ThreadHoverCard")>()),
  ThreadHoverCardPopup: (_props: { children: ReactNode }) => null,
}));

const seatThread = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("seat") };

const task = (extra: Record<string, unknown> = {}) => {
  const view = parseTask({
    id: "t1",
    number: 12,
    title: "Fix the sync",
    body: "Make the sync stop dropping rows.",
    state: "doing",
    lane: "ready",
    team: "development",
    source: { kind: "thread", ref: "env-source/filed-from" },
    parent: { id: "t0", number: 7, title: "Rework the sync", state: "doing", lane: "ready" },
    council: { seats: [{ seat: "builder", activity: "active", harness: "claude" }] },
    card: {
      id: "t1",
      number: 12,
      title: "Fix the sync",
      lane: "ready",
      parts: [{ id: "t2", number: 13, title: "Fix the cursor", state: "ready", lane: "queue" }],
    },
    ...extra,
  });
  if (!view) throw new Error("the fixture did not parse");
  return view;
};

// The board's read of the task and its doors, as the task view provides them.
const board = (extra: Partial<BoardTask> = {}): BoardTask => ({
  environmentId: null,
  taskId: "t1",
  task: task(),
  stale: false,
  refresh: () => {},
  openTask: vi.fn(),
  openThread: vi.fn(),
  seats: {
    thread: (seat) => (seat === "builder" ? seatThread : null),
    current: null,
    open: vi.fn(),
  },
  ...extra,
});

const everything = () => (
  <>
    <TaskBadges onOpenDetails={() => {}} onOpenTab={() => {}} />
    <TaskDetailsItem />
    <TaskRelatedWork />
  </>
);

it("draws no badge, Task item or child task outside a board task's view, with the item on", async () => {
  await using screen = await render(everything());
  expect(screen.container.querySelector("[data-task-badges]")).toBeNull();
  expect(screen.container.querySelector("[data-thread-details-task]")).toBeNull();
  expect(screen.container.querySelector("[data-task-related-work]")).toBeNull();
  await screen.rerender(<BoardTaskContext value={board()}>{everything()}</BoardTaskContext>);
  await expect.element(screen.getByRole("region", { name: "Task" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /^Stage: / })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /Fix the cursor/ })).toBeVisible();
});

it("opens each badge's detail where it is, and says a reading is stale rather than drop it", async () => {
  const onOpenDetails = vi.fn();
  const onOpenTab = vi.fn();
  const value = board({ stale: true });
  await using screen = await render(
    <BoardTaskContext value={value}>
      <TaskBadges onOpenDetails={onOpenDetails} onOpenTab={onOpenTab} />
    </BoardTaskContext>,
  );
  await screen.getByRole("button", { name: /^Stage: / }).click();
  expect(onOpenDetails).toHaveBeenCalledOnce();
  await screen.getByRole("button", { name: "Task evidence" }).click();
  expect(onOpenTab).toHaveBeenLastCalledWith("task-evidence");
  await screen.getByRole("button", { name: "Deployments" }).click();
  expect(onOpenTab).toHaveBeenLastCalledWith("task-deployments");
  expect(screen.container.querySelectorAll("[data-task-badge-stale]")).toHaveLength(2);

  // The team's rows: a seat with a conversation opens it in the centre, and the list gives way.
  await screen.getByRole("button", { name: /^Team development/ }).click();
  await page.getByText("builder", { exact: true }).click();
  expect(value.seats.open).toHaveBeenCalledWith(seatThread);
  await expect.element(page.getByText("builder", { exact: true })).not.toBeInTheDocument();
});

it("leads with what the person owes, and opens the conversation the task came from in the centre", async () => {
  const value = board({
    task: task({
      brief: { headline: "Choose how the sync recovers" },
      card: { id: "t1", number: 12, title: "Fix the sync", lane: "ready", waitingOn: "person" },
    }),
  });
  await using screen = await render(
    <BoardTaskContext value={value}>
      <TaskDetailsItem />
    </BoardTaskContext>,
  );
  const sections = screen.container.querySelectorAll("[data-thread-details-task] h3 > button");
  expect(sections[0]?.textContent).toBe("Needs you");
  await expect.element(screen.getByText("Choose how the sync recovers")).toBeVisible();
  await expect.element(screen.getByText("Make the sync stop dropping rows.")).toBeVisible();
  await screen.getByRole("button", { name: "Linked conversations" }).click();
  await screen.getByRole("button", { name: "the conversation it came from" }).click();
  expect(value.openThread).toHaveBeenCalledWith({
    environmentId: "env-source",
    threadId: "filed-from",
  });
});

it("lists the parent and the parts as rows that each open their task", async () => {
  const value = board();
  await using screen = await render(
    <BoardTaskContext value={value}>
      <TaskRelatedWork />
    </BoardTaskContext>,
  );
  await screen.getByRole("button", { name: /Fix the cursor/ }).click();
  expect(value.openTask).toHaveBeenLastCalledWith("t2");
  await screen.getByRole("button", { name: /Rework the sync/ }).click();
  expect(value.openTask).toHaveBeenLastCalledWith("t0");
});
