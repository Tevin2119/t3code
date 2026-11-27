import "~/index.css";

import { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { BoardSidebarPanel } from "./BoardSidebarPanel";

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
  card: {
    id: "t1",
    number: 12,
    title: "Fix the sync",
    lane: "ready",
    waitingOn: "person",
  },
};
const reads: string[] = [];

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
        ? taskBody
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
vi.mock("./taskActions", () => ({
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
});

const column = () => (
  <SidebarProvider>
    <div style={{ width: 300 }}>
      <BoardSidebarPanel />
    </div>
  </SidebarProvider>
);

it("shows the open task's facts in the column, and keeps the task list one fold away", async () => {
  await using screen = await render(column(), {
    router: `/board?task=t1&environment=${environmentId}`,
  });
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
  // The task view polls the task; the column reads that same reading on no clock of its own.
  expect(reads).toContain("/api/tasks/t1 once");
  expect(
    reads.filter((read) => read.startsWith("/api/tasks/t1 ") && read !== "/api/tasks/t1 once"),
  ).toEqual([]);
});
