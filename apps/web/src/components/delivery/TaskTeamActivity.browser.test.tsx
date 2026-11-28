import "../../index.css";

import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { CouncilSeat } from "../../lib/delivery";
import { SeatThreadRow } from "./TaskTeamActivity";

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
  cutByT3: null,
  live: null,
  threadId: null,
  ...extra,
});

const catalog = { entries: [], providers: [], options: {} } as unknown as Parameters<
  typeof SeatThreadRow
>[0]["catalog"];

const rows = (seats: ReadonlyArray<CouncilSeat>, onOpen = vi.fn()) => (
  <ul>
    {seats.map((item) => (
      <SeatThreadRow
        key={item.seat}
        seat={item}
        catalog={catalog}
        onOpen={(intent) => onOpen(item.seat, intent)}
      />
    ))}
  </ul>
);

it("keeps a long seat detail inside a 220px pane, with both name and detail ellipsized", async () => {
  const container = document.createElement("div");
  container.style.width = "220px";
  await using screen = await render(rows([seat({})]), {
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

it("opens a seat's own conversation from its row, as a subagent row opens its thread", async () => {
  const open = vi.fn();
  await using _screen = await render(
    rows([seat({ seat: "builder" }), seat({ seat: "qa", blockedBy: null })], open),
  );
  await page.getByRole("button", { name: /builder/ }).click();
  expect(open).toHaveBeenCalledExactlyOnceWith("builder", "primary");
});
