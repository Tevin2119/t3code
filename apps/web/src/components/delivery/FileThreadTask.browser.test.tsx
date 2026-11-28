import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { act, render } from "../../../test/render";
import { FileThreadTaskDialogHost, ThreadFiledTasks } from "./FileThreadTask";
import { openFileThreadTaskDialog } from "./fileThreadTaskDialogState";

const mock = vi.hoisted(() => ({
  file: vi.fn(),
  toast: vi.fn(),
  refresh: vi.fn(),
  tasks: [] as unknown[],
  allowed: true,
}));
vi.mock(import("../../state/delivery"), async (importOriginal) => ({
  ...(await importOriginal()),
  useDeliveryEnabled: () => true,
  useDeliveryRead: (_env: unknown, path: string | null) =>
    ({
      body: path?.startsWith("/api/tasks?origin=")
        ? mock.tasks
        : path === "/api/boards"
          ? [
              { id: "unsorted", title: "Unsorted" },
              { id: "t3-work", title: "T3 work" },
              { id: "engine", title: "Engine" },
            ]
          : null,
      error: null,
      isPending: false,
      readAt: "2026-11-28T05:00:00Z",
      failure: null,
      refresh: mock.refresh,
    }) as never,
  useFileThreadTask: () => ({ allowed: mock.allowed, file: mock.file }),
}));
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadShell: () => ({ title: "Make exports faster" }) as never,
  useThreadProjection: () =>
    ({
      projection: {
        messages: [
          { role: "user", text: "Exports take a minute on big projects." },
          { role: "assistant", text: "The zip step reads every file twice." },
        ],
      },
    }) as never,
}));
vi.mock(import("../ui/toast"), async (importOriginal) => ({
  ...(await importOriginal()),
  toastManager: { add: mock.toast } as never,
}));

const threadRef = {
  environmentId: EnvironmentId.make("host"),
  threadId: ThreadId.make("thread-1"),
};
const filed = {
  id: "task-1007",
  number: 1007,
  title: "Make exports faster",
  lane: "draft",
  state: "draft",
  origin: "thread:host/thread-1",
};

beforeEach(() => {
  appAtomRegistry.reset();
  mock.file.mockReset();
  mock.toast.mockReset();
  mock.refresh.mockReset();
  mock.tasks = [];
  mock.allowed = true;
});

it("files an edited draft written from the thread on the picked board", async () => {
  mock.file.mockResolvedValue({
    ok: true,
    filing: { created: true, task: { ...filed, board: "t3-work", team: "development" } },
  });
  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ThreadFiledTasks threadRef={threadRef} />
      <FileThreadTaskDialogHost />
    </RegistryContext.Provider>,
  );
  expect(document.querySelector("[data-thread-filed-task]")).toBeNull();
  await screen.getByRole("button", { name: "File a task from this thread" }).click();

  const dialog = screen.getByRole("dialog");
  const title = dialog.getByRole("textbox", { name: "Title" });
  const asked = dialog.getByRole("textbox", { name: "What is asked" });
  // Written from the conversation, for the person to change before anything is filed.
  await expect.element(title).toHaveValue("Make exports faster");
  expect((asked.element() as HTMLTextAreaElement).value).toContain(
    "Exports take a minute on big projects.",
  );
  // Picked from the engine's boards, never typed; the kept views are not offered.
  const submit = dialog.getByRole("button", { name: "File draft" });
  await expect.element(submit).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Board" }).click();
  await expect.element(screen.getByRole("option", { name: "Unsorted" })).not.toBeInTheDocument();
  await screen.getByRole("option", { name: "T3 work" }).click();
  await title.fill("Speed up exports");
  await submit.click();

  expect(mock.file).toHaveBeenCalledWith({
    threadId: "thread-1",
    board: "t3-work",
    title: "Speed up exports",
    body: expect.stringContaining("The zip step reads every file twice."),
  });
  await expect.element(dialog).not.toBeInTheDocument();
  expect(mock.refresh).toHaveBeenCalled();
  expect(mock.toast).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "success", title: "Filed as task #1007" }),
  );
});

it("shows each task filed from the thread, linking to it, and keeps the dialog open on a replay", async () => {
  mock.tasks = [filed];
  mock.file.mockResolvedValue({
    ok: true,
    filing: { created: false, task: { ...filed, board: "t3-work", team: "development" } },
  });
  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ThreadFiledTasks threadRef={threadRef} />
      <FileThreadTaskDialogHost />
    </RegistryContext.Provider>,
  );
  const row = screen.getByRole("button", { name: /Filed as task #1007/ });
  await expect.element(row).toBeVisible();
  // Where the task stands on the board, beside its number.
  expect(row.element().textContent).toBe("Filed as task #1007Draft");

  // Filing it again with edits replays the same task: the dialog stays open and says the edits
  // were not saved, with no success toast.
  await screen.getByRole("button", { name: "File a task from this thread" }).click();
  const dialog = screen.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Board" }).click();
  await screen.getByRole("option", { name: "T3 work" }).click();
  await dialog.getByRole("textbox", { name: "Title" }).fill("Edited title");
  await dialog.getByRole("button", { name: "File draft" }).click();
  const notice = dialog.getByRole("alert");
  await expect.element(notice).toBeVisible();
  expect(notice.element().textContent).toContain("already filed on this board as task #1007");
  expect(notice.element().textContent).toContain("the edits here were not saved");
  expect(mock.toast).not.toHaveBeenCalled();
  await expect.element(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("Edited title");
  await notice.getByRole("link", { name: "task #1007" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(screen.router?.state.location.search).toEqual({ environment: "host", task: "task-1007" });

  await row.click();
  expect(screen.router?.state.location.search).toEqual({ environment: "host", task: "task-1007" });
});

it("keeps the dialog open and files nothing without the permission to", async () => {
  mock.allowed = false;
  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ThreadFiledTasks threadRef={threadRef} />
      <FileThreadTaskDialogHost />
    </RegistryContext.Provider>,
  );
  // The panel does not offer what this connection cannot do.
  expect(document.querySelector("[data-file-thread-task]")).toBeNull();
  await act(() => openFileThreadTaskDialog(threadRef));
  const dialog = screen.getByRole("dialog");
  await expect
    .element(dialog.getByText("This connection does not have permission to file board tasks."))
    .toBeVisible();
  await expect.element(dialog.getByRole("button", { name: "File draft" })).toBeDisabled();
  expect(mock.file).not.toHaveBeenCalled();
});
