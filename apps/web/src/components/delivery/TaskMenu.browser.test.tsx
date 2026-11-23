import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { parseTask } from "../../lib/delivery";
import { TaskMenu } from "./TaskMenu";

vi.mock(import("../../state/delivery"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePersonName: () => "Sam",
  useDeliveryAct: () => vi.fn(),
  useDeliveryRead: () =>
    ({ body: [], error: null, isPending: false, readAt: null, refresh: () => {} }) as never,
}));

const task = (extra: Record<string, unknown> = {}) => {
  const view = parseTask({
    id: "t1",
    number: 12,
    title: "Fix the sync",
    state: "ready",
    lane: "ready",
    card: { id: "t1", number: 12, title: "Fix the sync", lane: "ready" },
    ...extra,
  });
  if (!view) throw new Error("the fixture did not parse");
  return view;
};

function menu(props: Partial<Parameters<typeof TaskMenu>[0]> = {}) {
  return (
    <TaskMenu
      environmentId={null}
      task={task()}
      actions={["pause"]}
      taskActions={{ busy: false, run: vi.fn(), moveTo: vi.fn() }}
      onCreateTask={() => {}}
      onAllocate={() => {}}
      onChanged={() => {}}
      onProblem={() => {}}
      {...props}
    />
  );
}

const open = () => page.getByRole("button", { name: "What can be done with this task" }).click();

it("names each action with what it does, and runs it on the task", async () => {
  const run = vi.fn();
  const onAllocate = vi.fn();
  const subject = task();
  await using _screen = await render(
    menu({ task: subject, taskActions: { busy: false, run, moveTo: vi.fn() }, onAllocate }),
  );
  await open();
  await expect
    .element(page.getByText("Choose the machine for it, or follow its move."))
    .toBeVisible();
  await expect
    .element(
      page.getByText(
        "Nothing more is started for this task until it is resumed. A running step is stopped.",
      ),
    )
    .toBeVisible();
  await page.getByRole("menuitem", { name: /^Pause/ }).click();
  expect(run).toHaveBeenCalledWith(subject.card, "pause");
  await open();
  await page.getByRole("menuitem", { name: /^Allocate/ }).click();
  expect(onAllocate).toHaveBeenCalledOnce();
});

it("leaves the source conversation to the Task item's Made from row, even for a task filed from one", async () => {
  await using _screen = await render(
    menu({ task: task({ source: { kind: "thread", ref: "env-source/filed-from" } }) }),
  );
  await open();
  await expect.element(page.getByRole("menuitem", { name: /^Allocate/ })).toBeVisible();
  await expect
    .element(page.getByRole("menuitem", { name: /Inspect source workspace/ }))
    .not.toBeInTheDocument();
});

it("offers to make a task of a chat only while it is a chat", async () => {
  const onCreateTask = vi.fn();
  await using screen = await render(menu({ onCreateTask }));
  await open();
  await expect
    .element(page.getByRole("menuitem", { name: /Create task from chat/ }))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await screen.rerender(menu({ onCreateTask, task: task({ workflow: "chat", state: "chat" }) }));
  await open();
  await page.getByRole("menuitem", { name: /Create task from chat/ }).click();
  expect(onCreateTask).toHaveBeenCalledOnce();
});
