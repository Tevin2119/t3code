import "~/index.css";

import { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { useBoardStore } from "../../state/delivery";
import { BoardOpenTaskRoute, BoardSidebarPanel } from "./BoardSidebarPanel";

const environmentId = EnvironmentId.make("env-board");
const taskBody = {
  id: "t1",
  number: 12,
  title: "Fix the sync",
  body: "Make the sync stop dropping rows.",
  state: "doing",
  lane: "ready",
  team: "development",
  acceptance: ["No row is dropped"],
  actions: ["approve", "reject"],
  card: {
    id: "t1",
    number: 12,
    title: "Fix the sync",
    lane: "ready",
    waitingOn: "person",
  },
};
const reads: string[] = [];
let relatedThreads: ReadonlyArray<Record<string, string>> = [];

vi.mock(import("../../state/delivery"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePersonName: () => "Sam",
  useDeliveryAct: () => vi.fn(),
  useDeliveryEnabled: () => true,
  useDeliveryEnvironmentId: () => environmentId,
  useDeliveryRead: (
    _environment: unknown,
    path: string | null,
    options?: { readonly pollMs?: number },
  ) => {
    if (path) reads.push(`${path} ${options?.pollMs ?? "once"}`);
    const body =
      path === "/api/tasks/t1"
        ? { ...taskBody, relatedThreads }
        : path?.startsWith("/api/tasks?")
          ? [
              taskBody.card,
              { id: "t3", number: 13, title: "Tidy the logs", lane: "ready", state: "ready" },
            ]
          : [];
    return {
      body,
      error: null,
      failure: null,
      isPending: false,
      readAt: new Date().toISOString(),
      refresh: () => {},
    } as never;
  },
}));
vi.mock("./useTaskConversation", () => ({
  useTaskConversation: () => ({
    ref: null,
    state: { kind: "unlinked" },
    seats: { thread: () => null, rows: [] },
  }),
  useOpenSeatThread: () => vi.fn(),
}));
vi.mock("./taskActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./taskActions")>()),
  useTaskActions: () => ({ busy: false, problem: null, dialog: null, run: vi.fn() }),
}));
vi.mock("./EnvironmentPicker", () => ({ EnvironmentPicker: () => <p>Environment picker</p> }));
vi.mock("./SeatSettingsPanel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SeatSettingsPanel")>()),
  useSeatCatalog: () => ({ entries: [], providers: [], options: {} }),
  SeatSettingsPanel: () => null,
}));
vi.mock("../ThreadHoverCard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ThreadHoverCard")>()),
  ThreadHoverCardPopup: (_props: { children: ReactNode }) => null,
}));

beforeEach(async () => {
  await page.viewport(1400, 900);
  localStorage.clear();
  reads.length = 0;
  relatedThreads = [];
});

const column = (width = 300) => (
  <SidebarProvider>
    <BoardOpenTaskRoute>
      <div style={{ width }} data-test-column>
        <BoardSidebarPanel />
      </div>
    </BoardOpenTaskRoute>
  </SidebarProvider>
);
const route = `/board?task=t1&environment=${environmentId}`;

it("shows the open task's facts in the column, and keeps the task list one fold away", async () => {
  await using screen = await render(column(), { router: route });
  await expect.element(screen.getByRole("button", { name: "Back to board" })).toBeVisible();
  await expect.element(screen.getByRole("region", { name: "Task #12" })).toBeVisible();
  await expect.element(screen.getByText("Needs you")).toBeVisible();
  await expect.element(screen.getByText("Where it stands")).toBeVisible();
  await expect.element(screen.getByText(/What is asked/)).toBeVisible();
  await expect.element(screen.getByText("Make the sync stop dropping rows.")).toBeVisible();

  // The list, its search, New task and the environment are behind one fold.
  const tasks = screen.getByRole("button", { name: /Tasks/ });
  await expect.element(tasks).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByRole("button", { name: "New task" })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Tidy the logs")).not.toBeInTheDocument();
  await tasks.click();
  await expect.element(screen.getByRole("button", { name: "New task" })).toBeVisible();
  await expect.element(screen.getByText("Environment picker")).toBeVisible();
  await expect
    .element(screen.getByRole("searchbox", { name: "Search tasks" }).first())
    .toBeVisible();
  await expect.element(screen.getByText("Tidy the logs")).toBeVisible();
  // The task is read once for the column and the task view, on the one clock.
  const taskReads = reads.filter((read) => read.startsWith("/api/tasks/t1 "));
  expect(taskReads.length).toBeGreaterThan(0);
  expect(new Set(taskReads)).toEqual(new Set(["/api/tasks/t1 3000"]));
});

it("keeps an open task's facts above a shared board's notice", async () => {
  useBoardStore.getState().updateBoard(environmentId, () => ({ shared: true }));
  try {
    await using screen = await render(column(), { router: route });
    await expect.element(screen.getByRole("button", { name: "Back to board" })).toBeVisible();
    await expect.element(screen.getByRole("region", { name: "Task #12" })).toBeVisible();
    await expect.element(screen.getByText(/A shared board is selected/)).toBeVisible();
    const facts = document.querySelector("[data-board-panel-task-facts]")!;
    const notice = document.querySelector("[data-board-panel-shared]")!;
    expect(facts.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  } finally {
    useBoardStore.getState().updateBoard(environmentId, () => ({ shared: false }));
  }
});

it.each([256, 208])("fits the decisions in a %ipx column, nothing cut off", async (width) => {
  await using screen = await render(column(width), { router: route });
  const decisions = screen.getByRole("region", { name: "Your decision" });
  await expect.element(decisions).toBeVisible();
  const bounds = document.querySelector("[data-test-column]")!.getBoundingClientRect();
  for (const action of ["approve", "reject"]) {
    const button = document.querySelector(`[data-task-action="${action}"]`)!;
    const box = button.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(box.right).toBeLessThanOrEqual(bounds.right);
    expect(box.left).toBeGreaterThanOrEqual(bounds.left);
  }
  const region = decisions.element();
  expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth);
});

it("lists the task's related threads in the column with the lineage's own rows", async () => {
  relatedThreads = [
    {
      key: "side-1",
      environmentId,
      threadId: "side-chat-1",
      role: "side",
      setBy: environmentId,
      setAt: "2026-11-28T06:00:00.000Z",
    },
    {
      key: "linked-1",
      environmentId: "env-elsewhere",
      threadId: "thread-elsewhere",
      role: "linked",
      setBy: "env-elsewhere",
      setAt: "2026-11-28T06:01:00.000Z",
    },
    // A role this build does not know is left out, not shown as one it does.
    { key: "odd", environmentId, threadId: "odd", role: "watcher", setBy: environmentId },
  ];
  await using screen = await render(column(), { router: route });
  const section = screen.getByRole("region", { name: "Related threads" });
  await expect.element(section).toBeVisible();
  const list = section.getByRole("list", { name: "Related threads" });
  await expect.element(list).toBeVisible();
  const rows = [...list.element().querySelectorAll(":scope > li")].map((row) =>
    row.textContent?.trim(),
  );
  expect(rows).toEqual(["Side chat", "Linked thread"]);
  // Below the task's own facts, in the left column.
  const facts = document.querySelector("[data-board-panel-task-facts]")!;
  expect(facts.contains(section.element())).toBe(true);
});

it("shows no related threads section for a task without any", async () => {
  await using screen = await render(column(), { router: route });
  await expect.element(screen.getByRole("region", { name: "Task #12" })).toBeVisible();
  expect(document.querySelector("[data-task-related-threads]")).toBeNull();
});
