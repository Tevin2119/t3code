import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import "~/index.css";
import { useThreadInspection } from "../chat/ThreadInspectionContext";
import { TaskWorkspacePanels } from "./TaskWorkspacePanels";

vi.mock("../ChatView", () => ({
  default: ({ environmentId, threadId }: { environmentId: string; threadId: string }) => {
    const inspect = useThreadInspection();
    return (
      <div>
        <p>
          Native workspace {environmentId}/{threadId}
        </p>
        <button
          onClick={() =>
            inspect?.({
              environmentId: EnvironmentId.make("child-env"),
              threadId: ThreadId.make("child-thread"),
            })
          }
        >
          Inspect child
        </button>
      </div>
    );
  },
}));
vi.mock("../chat/ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: () => <p>Agent lineage</p>,
}));

beforeEach(async () => {
  await page.viewport(1400, 900);
});

function TaskExample({ owner }: { owner: string }) {
  const [details, setDetails] = useState(false);
  return (
    <div style={{ height: 700 }}>
      <TaskWorkspacePanels
        owner={owner}
        detailsOpen={details}
        onDetailsOpenChange={setDetails}
        details={<p>TaskExample configuration</p>}
        conversation={<textarea aria-label="TaskExample reply" />}
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

it("keeps originless tasks usable and explains unavailable native tools", async () => {
  await using screen = await render(<TaskExample owner="originless" />);
  await expect
    .element(screen.getByRole("button", { name: "Inspect source workspace" }))
    .toBeDisabled();
  await expect.element(screen.getByRole("textbox", { name: "TaskExample reply" })).toBeVisible();
});

it("inspects the real source environment and preserves the task reply on return", async () => {
  await using screen = await render(
    <TaskWorkspacePanels
      owner="board-env:task"
      source={{
        environmentId: EnvironmentId.make("source-env"),
        threadId: ThreadId.make("source-thread"),
      }}
      detailsOpen={false}
      onDetailsOpenChange={() => {}}
      details={<p>Configuration</p>}
      evidence={<p>Evidence</p>}
      deployments={<p>Deployments</p>}
      conversation={<textarea aria-label="Bound task answer" />}
    />,
  );
  await screen.getByRole("textbox", { name: "Bound task answer" }).fill("Task answer");
  await screen.getByRole("button", { name: "Inspect source workspace" }).click();
  await expect.element(screen.getByText("Native workspace source-env/source-thread")).toBeVisible();
  await screen.getByRole("button", { name: "Inspect child" }).click();
  await expect.element(screen.getByText("Native workspace child-env/child-thread")).toBeVisible();
  expect(screen.router?.state.location.pathname).toBe("/");
  await screen.getByRole("button", { name: "Source conversation", exact: true }).click();
  await expect.element(screen.getByText("Native workspace source-env/source-thread")).toBeVisible();
  await screen.getByRole("button", { name: "Back to task conversation" }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Bound task answer" }))
    .toHaveValue("Task answer");
});

it("resizes the task navigation with the native keyboard handle", async () => {
  await using screen = await render(<TaskExample owner="resize-task" />);
  await screen.getByRole("button", { name: "Toggle task details panel", exact: true }).click();
  const handle = screen.getByRole("separator", { name: "Resize task navigation" });
  await expect.element(handle).toBeVisible();
  const width = Number(handle.element().getAttribute("aria-valuenow"));
  await act(() => (handle.element() as HTMLElement).focus());
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(handle).toHaveAttribute("aria-valuenow", String(width + 16));
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
      openFirst
      detailsOpen={false}
      onDetailsOpenChange={() => {}}
      details={<p>Details</p>}
      conversation={<p>Centre</p>}
      evidence={<p>Engine facts</p>}
      deployments={<p>Deployments</p>}
    />
  );
  await using screen = await render(panel("a"));
  await expect.element(page.getByText("Engine facts")).toBeVisible();
  await page.getByRole("button", { name: "Close evidence", exact: true }).click();
  await screen.rerender(panel("b"));
  await expect
    .element(page.getByRole("button", { name: "Toggle right panel", exact: true }))
    .toHaveAttribute("aria-pressed", "false");
});
