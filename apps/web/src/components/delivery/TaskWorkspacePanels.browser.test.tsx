import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { beforeEach, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import "~/index.css";
import {
  selectThreadRightPanelState,
  taskPanelRef,
  useRightPanelStore,
} from "../../rightPanelStore";
import { TaskWorkspacePanels } from "./TaskWorkspacePanels";

beforeEach(async () => {
  await page.viewport(1400, 900);
});

// The centre puts the native toggles in its header, which the details card hangs from.
const centre =
  (label: string) =>
  (panel: {
    readonly controls: ReactNode;
    readonly anchor: (element: HTMLDivElement | null) => void;
  }) => (
    <div>
      <div ref={panel.anchor}>{panel.controls}</div>
      <textarea aria-label={label} />
    </div>
  );

function TaskExample({ owner }: { owner: string }) {
  return (
    <div style={{ height: 700 }}>
      <TaskWorkspacePanels
        owner={owner}
        thread={null}
        details={<p>TaskExample configuration</p>}
        renderConversation={centre("TaskExample reply")}
        evidence={<p>Candidate evidence for {owner}</p>}
        deployments={<p>Deployment rows for {owner}</p>}
      />
    </div>
  );
}

it("keeps the reply while evidence is opened and closed, and isolates saved panel state by task", async () => {
  localStorage.removeItem("t3code:task-evidence:panel-test-a");
  localStorage.removeItem("t3code:task-evidence:panel-test-b");
  await using screen = await render(<TaskExample key="a" owner="panel-test-a" />);
  await page.getByRole("textbox", { name: "TaskExample reply" }).fill("Keep this answer");
  await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
  await expect.element(page.getByText("Candidate evidence for panel-test-a")).toBeVisible();
  await page.getByRole("button", { name: "Close evidence", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "TaskExample reply" }))
    .toHaveValue("Keep this answer");
  await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
  await screen.rerender(<TaskExample key="b" owner="panel-test-b" />);
  await expect
    .element(page.getByRole("button", { name: "Toggle right panel", exact: true }))
    .toHaveAttribute("aria-pressed", "false");
  await screen.rerender(<TaskExample key="a-again" owner="panel-test-a" />);
  await expect.element(page.getByText("Candidate evidence for panel-test-a")).toBeVisible();
});

it("remembers the evidence panel width per task, not across tasks", async () => {
  const keyA = "t3code:task-evidence-width:width-task-a";
  const keyB = "t3code:task-evidence-width:width-task-b";
  // The retired shared key is orphaned: a stale value must not reach any task.
  localStorage.setItem("t3code:task-evidence-width", "600");
  localStorage.setItem(keyA, "520");
  localStorage.removeItem(keyB);
  const panelWidth = () =>
    document
      .querySelector<HTMLElement>("[data-preview-panel-mode]")
      ?.style.getPropertyValue("--resizable-width");
  try {
    await using screen = await render(<TaskExample key="a" owner="width-task-a" />);
    await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
    await expect.element(page.getByText("Candidate evidence for width-task-a")).toBeVisible();
    await expect.poll(panelWidth).toBe("520px");
    await screen.rerender(<TaskExample key="b" owner="width-task-b" />);
    await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
    await expect.element(page.getByText("Candidate evidence for width-task-b")).toBeVisible();
    await expect.poll(panelWidth).toBe("400px");
    expect(localStorage.getItem(keyB)).toBeNull();
  } finally {
    localStorage.removeItem("t3code:task-evidence-width");
    localStorage.removeItem(keyA);
    localStorage.removeItem(keyB);
  }
});

const taskThread = (name: string) => ({
  environmentId: EnvironmentId.make("env-panels"),
  threadId: ThreadId.make(name),
});
const threadPanel = (name: string) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, taskThread(name));

function ThreadTask(props: { readonly name: string }) {
  return (
    <TaskWorkspacePanels
      owner={`owner-${props.name}`}
      thread={taskThread(props.name)}
      details={<p>Configuration</p>}
      evidence={<p>Evidence rows</p>}
      deployments={<p>Deployment rows</p>}
      renderConversation={centre("Thread reply")}
    />
  );
}

it("gives a task with a thread no panel, toggles or details of its own, and opens nothing on it", async () => {
  await using screen = await render(<ThreadTask name="tabs-thread" />);
  await expect
    .element(screen.getByRole("button", { name: "Toggle right panel" }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: /Toggle thread details/ }))
    .not.toBeInTheDocument();
  expect(document.querySelector("[data-thread-details-card]")).toBeNull();
  // The thread view has the task's tabs behind its own + menu; nothing opens them unasked.
  expect(threadPanel("tabs-thread").isOpen).toBe(false);
  expect(threadPanel("tabs-thread").surfaces).toEqual([]);
});

it("opens a page's details in the native details card from the native toggle, and closes them", async () => {
  await using screen = await render(<TaskExample owner="details-card" />);
  await screen.getByRole("textbox", { name: "TaskExample reply" }).fill("Keep details draft");
  expect(document.body.textContent).not.toContain("TaskExample configuration");
  const toggle = screen.getByRole("button", { name: "Toggle thread details panel", exact: true });
  await toggle.click();
  await expect.element(page.getByText("TaskExample configuration")).toBeVisible();
  expect(document.querySelector("[data-thread-details-card]")?.textContent).toContain(
    "TaskExample configuration",
  );
  // No sheet of its own: the native card is the only one.
  expect(document.querySelector("[data-task-details-sheet]")).toBeNull();
  await toggle.click();
  await expect.element(page.getByText("TaskExample configuration")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("textbox", { name: "TaskExample reply" }))
    .toHaveValue("Keep details draft");
});

it("opens narrow-screen evidence as a sheet and restores the reply after closing", async () => {
  await page.viewport(700, 800);
  await using screen = await render(<TaskExample owner="narrow-task" />);
  await screen.getByRole("textbox", { name: "TaskExample reply" }).fill("Keep narrow draft");
  await screen.getByRole("button", { name: "Toggle right panel", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect.element(page.getByText("Candidate evidence for narrow-task")).toBeVisible();
  await page.getByRole("button", { name: "Close evidence", exact: true }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "TaskExample reply" }))
    .toHaveValue("Keep narrow draft");
});

it("hosts evidence and deployments as native right-panel tabs with native maximize", async () => {
  await using screen = await render(<TaskExample owner="native-tabs" />);
  const reply = screen.getByRole("textbox", { name: "TaskExample reply" });
  await reply.fill("Keep tab draft");
  const replyElement = reply.element();
  await screen.getByRole("button", { name: "Toggle right panel", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Task evidence", exact: true }))
    .toBeVisible();
  await expect.element(page.getByText("Candidate evidence for native-tabs")).toBeVisible();
  await page.getByRole("button", { name: "Deployments", exact: true }).click();
  await expect.element(page.getByText("Deployment rows for native-tabs")).toBeVisible();
  // Native maximize: the panel takes the conversation's place, which stays mounted.
  await page.getByRole("button", { name: "Maximize panel" }).click();
  await expect.poll(() => replyElement.checkVisibility()).toBe(false);
  await page.getByRole("button", { name: "Restore panel size" }).click();
  await expect.poll(() => replyElement.checkVisibility()).toBe(true);
  await page.getByRole("button", { name: "Close evidence", exact: true }).click();
  await expect.element(reply).toHaveValue("Keep tab draft");
  await screen.getByRole("button", { name: "Toggle right panel", exact: true }).click();
  // Reopening keeps the tab the person left on.
  await expect.element(page.getByText("Deployment rows for native-tabs")).toBeVisible();
});

it("opens no panel on a page unasked, and brings both tabs back after every one was closed", async () => {
  const panel = (key: string) => (
    <TaskWorkspacePanels
      key={key}
      owner="first-visit-task"
      thread={null}
      details={<p>Details</p>}
      renderConversation={centre("Centre")}
      evidence={<p>Engine facts</p>}
      deployments={<p>Deployments</p>}
    />
  );
  await using screen = await render(panel("a"));
  const toggle = page.getByRole("button", { name: "Toggle right panel", exact: true });
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  expect(page.getByText("Engine facts").query()).toBeNull();
  await toggle.click();
  await expect.element(page.getByText("Engine facts")).toBeVisible();
  // Every tab closed: the toggle is still the way back, with both tabs.
  await act(() => useRightPanelStore.getState().closeAllSurfaces(taskPanelRef("first-visit-task")));
  await screen.rerender(panel("b"));
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect.element(page.getByText("Engine facts")).toBeVisible();
  expect(
    selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      taskPanelRef("first-visit-task"),
    ).surfaces.map(({ kind }) => kind),
  ).toEqual(["task-evidence", "task-deployments"]);
});

it("offers its tabs on an empty panel and in the + menu, adding only the one picked", async () => {
  const ref = taskPanelRef("plus-menu-task");
  const surfaces = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces;
  await using screen = await render(<TaskExample owner="plus-menu-task" />);
  await act(() => useRightPanelStore.getState().show(ref));
  await screen.getByRole("button", { name: /Deployments/ }).click();
  await expect.element(page.getByText("Deployment rows for plus-menu-task")).toBeVisible();
  expect(surfaces()).toEqual([{ id: "task-deployments", kind: "task-deployments" }]);
  await page.getByRole("button", { name: "Add panel surface" }).click();
  await page.getByRole("menuitem", { name: /Task evidence/ }).click();
  await expect.element(page.getByText("Candidate evidence for plus-menu-task")).toBeVisible();
  expect(surfaces()).toEqual([
    { id: "task-deployments", kind: "task-deployments" },
    { id: "task-evidence", kind: "task-evidence" },
  ]);
});
