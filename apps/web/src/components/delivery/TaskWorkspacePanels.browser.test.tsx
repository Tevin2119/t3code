import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
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

// The centre puts the task's toggles under its header, as the task view does.
const centre =
  (label: string) =>
  ({ controls }: { readonly controls: ReactNode }) => (
    <div>
      {controls}
      <textarea aria-label={label} />
    </div>
  );

function TaskExample({ owner }: { owner: string }) {
  const [details, setDetails] = useState(false);
  return (
    <div style={{ height: 700 }}>
      <TaskWorkspacePanels
        owner={owner}
        thread={null}
        detailsOpen={details}
        onDetailsOpenChange={setDetails}
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

it("holds the task's details in the sheet only while it is open, and never a lineage of its own", async () => {
  await using screen = await render(<TaskExample owner="originless" />);
  expect(document.body.textContent).not.toContain("TaskExample configuration");
  await screen.getByRole("button", { name: "Toggle task details panel", exact: true }).click();
  await expect.element(page.getByText("TaskExample configuration")).toBeVisible();
  expect(
    document.querySelector("[data-task-details-sheet] [data-thread-relationships-panel]"),
  ).toBe(null);
  await page.getByRole("button", { name: "Close task details", exact: true }).click();
  await expect.element(page.getByText("TaskExample configuration")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("textbox", { name: "TaskExample reply" })).toBeVisible();
});

const taskThread = (name: string) => ({
  environmentId: EnvironmentId.make("env-panels"),
  threadId: ThreadId.make(name),
});
const threadPanel = (name: string) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, taskThread(name));

function ThreadTask(props: { readonly name: string; readonly openFirst?: boolean }) {
  return (
    <TaskWorkspacePanels
      owner={`owner-${props.name}`}
      thread={taskThread(props.name)}
      openFirst={props.openFirst === true}
      detailsOpen={false}
      onDetailsOpenChange={() => {}}
      details={<p>Configuration</p>}
      evidence={<p>Evidence rows</p>}
      deployments={<p>Deployment rows</p>}
      renderConversation={({ controls, openTab }) => (
        <div>
          {controls}
          <button onClick={() => openTab("task-deployments")}>Open the deployments</button>
        </div>
      )}
    />
  );
}

it("gives a task with a thread no panel or toggles of its own, and opens its tabs on the thread's", async () => {
  await using screen = await render(<ThreadTask name="tabs-thread" />);
  await expect
    .element(screen.getByRole("button", { name: "Toggle right panel" }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Toggle task details panel" }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Open the deployments" }).click();
  expect(threadPanel("tabs-thread")).toMatchObject({
    isOpen: true,
    activeSurfaceId: "task-deployments",
    surfaces: [{ kind: "task-evidence" }, { kind: "task-deployments" }],
  });
  // The thread view draws them; nothing here does.
  expect(page.getByText("Deployment rows").query()).toBeNull();
});

it("opens a task thread's panel at its tabs on the task's first visit, once", async () => {
  localStorage.removeItem("t3code:task-panel-first-open:owner-first-thread");
  await using screen = await render(<ThreadTask key="a" name="first-thread" openFirst />);
  await expect.poll(() => threadPanel("first-thread").isOpen).toBe(true);
  expect(threadPanel("first-thread").activeSurfaceId).toBe("task-evidence");
  await act(() => useRightPanelStore.getState().closeAllSurfaces(taskThread("first-thread")));
  await screen.rerender(<ThreadTask key="b" name="first-thread" openFirst />);
  expect(threadPanel("first-thread").surfaces).toEqual([]);
});

it("opens the task details as a sheet at desktop width, and closes them", async () => {
  await using screen = await render(<TaskExample owner="details-sheet" />);
  await screen.getByRole("textbox", { name: "TaskExample reply" }).fill("Keep details draft");
  await screen.getByRole("button", { name: "Toggle task details panel", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect.element(page.getByText("TaskExample configuration")).toBeVisible();
  await page.getByRole("button", { name: "Close task details", exact: true }).click();
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

it("opens the right panel on a task's first visit only when asked, and not again once closed", async () => {
  const panel = (key: string) => (
    <TaskWorkspacePanels
      key={key}
      owner="first-visit-task"
      thread={null}
      openFirst
      detailsOpen={false}
      onDetailsOpenChange={() => {}}
      details={<p>Details</p>}
      renderConversation={({ controls }) => (
        <div>
          {controls}
          <p>Centre</p>
        </div>
      )}
      evidence={<p>Engine facts</p>}
      deployments={<p>Deployments</p>}
    />
  );
  await using screen = await render(panel("a"));
  await expect.element(page.getByText("Engine facts")).toBeVisible();
  await page.getByRole("button", { name: "Close evidence", exact: true }).click();
  await screen.rerender(panel("b"));
  const toggle = page.getByRole("button", { name: "Toggle right panel", exact: true });
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  // Closing every tab empties the panel, which is not a first visit either.
  await toggle.click();
  await expect.element(page.getByText("Engine facts")).toBeVisible();
  await act(() => useRightPanelStore.getState().closeAllSurfaces(taskPanelRef("first-visit-task")));
  await screen.rerender(panel("c"));
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  expect(page.getByText("Engine facts").query()).toBeNull();
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
