import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { parseCards } from "../../lib/delivery";
import { ThreadTaskOpenActions } from "./ThreadTaskLinks";

const env = EnvironmentId.make("env-a");
const cards = parseCards([
  { id: "task-1", number: 2249, title: "Notify an orchestrator", lane: "intake" },
  { id: "task-2", number: 2248, title: "Testing lane shows", lane: "validation" },
  { id: "task-3", number: 2246, title: "Send now", lane: "needs-decision" },
]);

it("opens the only task straight from the button, with no dropdown", async () => {
  const one = parseCards([{ id: "task-1", number: 2249, title: "Notify an orchestrator" }]);
  await using screen = await render(<ThreadTaskOpenActions tasks={one} environmentId={env} />);
  await userEvent.click(screen.getByRole("button", { name: "Open #2249" }));
  await vi.waitFor(() => {
    expect(screen.router?.state.location.pathname).toBe("/board");
    expect(screen.router?.state.location.search).toMatchObject({ task: "task-1" });
  });
});

it("lists every task behind the chevron and opens the chosen one on the board", async () => {
  await using screen = await render(<ThreadTaskOpenActions tasks={cards} environmentId={env} />);
  await userEvent.click(
    screen.getByRole("button", { name: "Choose a task made from this conversation" }),
  );
  await vi.waitFor(() =>
    expect(page.getByRole("menuitem", { name: /#2246 Send now/ })).toBeInTheDocument(),
  );
  expect(await page.getByRole("menuitem").elements()).toHaveLength(3);
  await userEvent.click(page.getByRole("menuitem", { name: /#2246 Send now/ }));
  await vi.waitFor(() => {
    expect(screen.router?.state.location.pathname).toBe("/board");
    expect(screen.router?.state.location.search).toMatchObject({ task: "task-3" });
  });
});
