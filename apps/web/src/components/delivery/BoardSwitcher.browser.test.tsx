import "~/index.css";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { parseCard } from "../../lib/delivery";
import { switcherGroups } from "./BoardSidebarPanel.logic";
import { BoardSwitcherRows } from "./BoardSwitcher";

const card = (id: string, number: number, title: string) =>
  parseCard({ id, number, title, lane: "ready", state: "ready" });
const seatThread = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("seat") };

it("draws the board's tasks on the row shell: the open task as the page, its family nested under its parent", async () => {
  const onOpenTask = vi.fn();
  const onOpenSeat = vi.fn();
  const parent = card("t1", 1, "Rework the sync");
  const open = card("t2", 2, "Fix the cursor");
  const rows = switcherGroups([parent, open, card("t3", 3, "Another task")], {
    open,
    parent: { id: "t1", number: 1, title: "Rework the sync", state: "ready", lane: "ready" },
    children: [],
    seats: [{ seat: "builder", activity: "active", thread: seatThread }],
  }).open;
  await using screen = await render(
    <div style={{ width: 256 }}>
      <BoardSwitcherRows
        rows={rows}
        openSeat={null}
        onOpenTask={onOpenTask}
        onOpenSeat={onOpenSeat}
      />
    </div>,
  );
  const current = screen.getByRole("button", { name: /Fix the cursor/ });
  await expect.element(current).toHaveAttribute("aria-current", "page");
  await expect
    .element(screen.getByRole("button", { name: /Rework the sync/ }))
    .not.toHaveAttribute("aria-current");
  // Each level sits further in than the one it is nested under.
  const start = (name: RegExp) =>
    Number.parseFloat(getComputedStyle(screen.getByRole("button", { name }).element()).paddingLeft);
  expect(start(/Fix the cursor/)).toBeGreaterThan(start(/Rework the sync/));
  expect(start(/Seat builder/)).toBeGreaterThan(start(/Fix the cursor/));
  expect(start(/Another task/)).toBe(start(/Rework the sync/));

  await screen.getByRole("button", { name: /Rework the sync/ }).click();
  expect(onOpenTask).toHaveBeenCalledWith("t1");
  // A seat opens its conversation in the centre; the open task stays the page.
  await screen.getByRole("button", { name: /Seat builder/ }).click();
  expect(onOpenSeat).toHaveBeenCalledWith(seatThread);
  await expect.element(current).toHaveAttribute("aria-current", "page");
  // Reachable by keyboard, as a thread row is.
  screen
    .getByRole("button", { name: /Another task/ })
    .element()
    .focus();
  await userEvent.keyboard("{Enter}");
  expect(onOpenTask).toHaveBeenLastCalledWith("t3");
});
