import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import type { DeliveryCard } from "../../lib/delivery";
import { useTaskActions } from "./taskActions";

const act = vi.hoisted(() => vi.fn());
vi.mock(import("../../state/delivery"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePersonName: () => "Sam",
  useDeliveryAct: () => act,
  useDeliveryRead: () =>
    ({ body: null, error: null, isPending: false, readAt: null, refresh: () => {} }) as never,
}));

const card = {
  id: "t1",
  number: 12,
  title: "Fix the sync",
  state: "doing",
  flow: "standard",
  run: null,
  partOf: null,
  parts: [],
  publication: null,
} as unknown as DeliveryCard;

function Harness() {
  const actions = useTaskActions(EnvironmentId.make("env-a"), { onDone: () => {} });
  return (
    <>
      <button type="button" onClick={() => actions.run(card, "close")}>
        Close it
      </button>
      {actions.dialog}
    </>
  );
}

it("asks why an unfinished task is closed and sends the trimmed reason", async () => {
  act.mockResolvedValue({ ok: true });
  await using _screen = await render(<Harness />);
  await page.getByRole("button", { name: "Close it" }).click();
  expect(act).not.toHaveBeenCalled();
  const confirm = page.getByRole("button", { name: "Close task" });
  await expect.element(confirm).toBeDisabled();
  await userEvent.fill(page.getByRole("textbox", { name: "Why it is closed" }), "   ");
  await expect.element(confirm).toBeDisabled();
  await userEvent.fill(
    page.getByRole("textbox", { name: "Why it is closed" }),
    "  Superseded by #13  ",
  );
  await confirm.click();
  expect(act).toHaveBeenCalledWith("/api/tasks/t1/control", {
    action: "close",
    reason: "Superseded by #13",
    by: "Sam",
  });
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});
