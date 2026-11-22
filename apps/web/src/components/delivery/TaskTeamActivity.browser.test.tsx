import "../../index.css";

import type { ReactNode } from "react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { parseCard, type CouncilSeat, type TaskView } from "../../lib/delivery";
import { TaskTeamActivity } from "./TaskTeamActivity";

vi.mock("./SeatSettingsPanel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SeatSettingsPanel")>()),
  useSeatCatalog: () => ({ entries: [], providers: [], options: {} }),
  SeatSettingsPanel: () => null,
}));
vi.mock("../ThreadHoverCard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ThreadHoverCard")>()),
  ThreadHoverCardPopup: (_props: { children: ReactNode }) => null,
}));
vi.mock("../chat/ThreadRelationshipIcon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chat/ThreadRelationshipIcon")>()),
  ThreadRelationshipIcon: () => <i className="size-4 shrink-0" />,
  threadRelationshipStatusLabel: (status: string) => status,
}));

const LONG_SEAT = "independent-reviewer-for-the-accounts-migration-and-the-ledger";

const seat = (extra: Partial<CouncilSeat>): CouncilSeat => ({
  seat: "reviewer-for-the-ledger",
  role: "review",
  harness: "claude",
  provider: "claude",
  required: true,
  requestedModel: "claude-opus",
  actualModel: null,
  reasoning: "high",
  access: "full",
  activity: "waiting",
  blockedBy: LONG_SEAT,
  waitingWhy: null,
  stage: null,
  verdict: null,
  attempts: 1,
  live: null,
  threadId: null,
  ...extra,
});

const task = {
  id: "task-1",
  team: "development",
  defaults: 0,
  lane: "implementation",
  publications: [],
  settings: [],
  card: parseCard({ lane: "implementation" })!,
  council: { seats: [seat({})] },
} as unknown as TaskView;

it("keeps a long seat detail inside a 220px pane, with both name and detail ellipsized", async () => {
  const container = document.createElement("div");
  container.style.width = "220px";
  await using screen = await render(<TaskTeamActivity environmentId={null} task={task} />, {
    container,
  });
  const detail = screen.container.querySelector<HTMLElement>("[data-seat-detail]")!;
  expect(detail.textContent).toBe(`waits for ${LONG_SEAT}`);
  const name = [...screen.container.querySelectorAll<HTMLElement>("[data-task-seat] span")].find(
    (node) => node.textContent === "reviewer-for-the-ledger",
  )!;
  const pane = container.getBoundingClientRect();

  expect(detail.getBoundingClientRect().right).toBeLessThanOrEqual(pane.right);
  expect(name.getBoundingClientRect().width).toBeGreaterThan(0);
  // The ellipsis engages: the text is wider than the box it is clipped to.
  expect(detail.scrollWidth).toBeGreaterThan(detail.clientWidth);
  expect(getComputedStyle(detail).textOverflow).toBe("ellipsis");
  expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
});

it("opens a seat's own conversation from its row, and leaves a seat with none inert", async () => {
  const open = vi.fn();
  const child = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("child") };
  const both = {
    ...task,
    council: { seats: [seat({ seat: "builder" }), seat({ seat: "qa", blockedBy: null })] },
  } as unknown as TaskView;
  await using screen = await render(
    <TaskTeamActivity
      environmentId={null}
      task={both}
      conversations={{
        thread: (name) => (name === "builder" ? child : null),
        current: child,
        open,
      }}
    />,
  );
  await page.getByRole("button", { name: /builder/ }).click();
  expect(open).toHaveBeenCalledExactlyOnceWith(child);
  await expect
    .element(page.getByRole("button", { name: /builder/ }))
    .toHaveAttribute("aria-current", "true");
  await expect.element(page.getByRole("button", { name: /qa/ })).not.toBeInTheDocument();
  expect(
    screen.container.querySelector('[data-task-seat="qa"]')?.getAttribute("data-seat-conversation"),
  ).toBe("no");
});
