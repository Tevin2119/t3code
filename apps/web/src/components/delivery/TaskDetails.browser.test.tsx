import "~/index.css";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { parseTask } from "../../lib/delivery";
import { BoardTaskContext, type BoardTask } from "./BoardTaskContext";
import { TaskDetailsItem } from "./TaskDetails";
import { TaskLineage } from "./TaskLineage";

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
  openTab: vi.fn(),
  decisions: null,
  discuss: null,
  thread: { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("lead") },
  seats: {
    thread: (seat) => (seat === "builder" ? seatThread : null),
    rows: [{ seat: "builder", activity: "active", target: seatThread }],
  },
  ...extra,
});

const everything = () => (
  <>
    <TaskDetailsItem />
    <TaskLineage />
  </>
);

it("draws no Task item or lineage rows outside a board task's view, with the item on", async () => {
  await using screen = await render(everything());
  expect(screen.container.querySelector("[data-thread-details-task]")).toBeNull();
  expect(screen.container.querySelector("[data-task-lineage]")).toBeNull();
  await screen.rerender(<BoardTaskContext value={board()}>{everything()}</BoardTaskContext>);
  await expect.element(screen.getByRole("region", { name: "Task #12" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /Fix the cursor/ })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /builder/ })).toBeVisible();
});

it("holds the engine's facts the header badges used to, and opens each tab from them", async () => {
  const value = board({ stale: true });
  await using screen = await render(
    <BoardTaskContext value={value}>
      <TaskDetailsItem />
    </BoardTaskContext>,
  );
  await expect
    .element(screen.getByText("This is the last reading. The engine has not answered since."))
    .toBeVisible();
  expect(screen.container.querySelector("[data-task-team]")?.textContent).toContain("development");
  await screen.getByRole("button", { name: "Evidence" }).click();
  expect(value.openTab).toHaveBeenLastCalledWith("task-evidence");
  await screen.getByRole("button", { name: /Deployments/ }).click();
  expect(value.openTab).toHaveBeenLastCalledWith("task-deployments");
});

it("offers a side chat of the task's thread only where one can start", async () => {
  await using screen = await render(
    <BoardTaskContext value={board()}>
      <TaskDetailsItem />
    </BoardTaskContext>,
  );
  await expect.element(screen.getByRole("button", { name: "Evidence" })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Discuss in a thread" }))
    .not.toBeInTheDocument();
  const discuss = vi.fn();
  await screen.rerender(
    <BoardTaskContext value={board({ discuss })}>
      <TaskDetailsItem />
    </BoardTaskContext>,
  );
  await screen.getByRole("button", { name: "Discuss in a thread" }).click();
  expect(discuss).toHaveBeenCalledOnce();
});

it("leads with what the person owes, and leaves the conversation it came from to the lineage", async () => {
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
  expect(screen.container.textContent).not.toContain("the conversation it came from");
});

it("lists the seats, the source and the related tasks as lineage rows", async () => {
  const value = board();
  await using screen = await render(
    <BoardTaskContext value={value}>
      <TaskLineage />
    </BoardTaskContext>,
  );
  await screen.getByRole("button", { name: /Fix the cursor/ }).click();
  expect(value.openTask).toHaveBeenLastCalledWith("t2");
  await screen.getByRole("button", { name: /Rework the sync/ }).click();
  expect(value.openTask).toHaveBeenLastCalledWith("t0");
  // The conversation it was made from is the lineage's related-thread row, at its own route.
  const source = screen.container.querySelector("[data-task-related-source]");
  expect(source?.textContent).toContain("Made from");
  expect(source?.querySelector("li")?.textContent).toContain("The conversation it came from");
  // A seat with a conversation is a row of its own, before the source and the tasks.
  expect(screen.container.querySelector("[data-task-seat='builder']")).not.toBeNull();
});
