import { act, use, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BoardTaskContext } from "./BoardTaskContext";
import { FullAutoAttribution } from "./TaskEngineLog";
import { TaskWorkspace } from "./TaskWorkspace";

const read = vi.hoisted(() => ({ body: null as unknown }));
const engine = vi.hoisted(() => ({
  act: vi.fn(async (_path: string, _body: unknown) => ({ ok: true }) as const),
  toast: vi.fn(),
  chrome: null as null | { readonly steer?: (text: string) => Promise<boolean> },
}));
vi.mock("../ui/badge", () => ({ Badge: "strong" }));
vi.mock("../ui/toast", () => ({ toastManager: { add: engine.toast } }));
vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  useGT: () => (text: string) => text,
}));
vi.mock("../../state/delivery", () => ({
  usePersonName: () => "Sam",
  useDeliveryAct: () => engine.act,
  useStaleReading: () => false,
  useDeliveryRead: () => ({
    body: read.body,
    error: null,
    failure: null,
    isPending: false,
    readAt: null,
    refresh: () => {},
  }),
}));
vi.mock("./taskActions", () => ({
  useTaskActions: () => ({
    busy: false,
    problem: null,
    run: vi.fn(),
    moveTo: vi.fn(),
    dialog: null,
  }),
}));
vi.mock("./useTaskConversation", () => ({
  useTaskConversation: () => ({
    state: { kind: "unlinked" },
    ref: null,
    seats: { thread: () => null, rows: [] },
  }),
}));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../../hooks/useLocalStorage", async () => {
  const { useState } = await import("react");
  return { useLocalStorage: (_key: string, initial: unknown) => useState(initial) };
});
// The editor, as it reads the board task it is opened in.
vi.mock("./TaskEditor", () => ({
  TaskEditor: (props: { readonly taskId: string | null; readonly framed?: boolean }) => {
    const board = use(BoardTaskContext);
    return (
      <p>{`Editor for ${props.taskId}${props.framed ? " framed" : ""} in board task ${board?.taskId}`}</p>
    );
  },
}));
// The task's page and its centre, as the task view hands them what they draw.
vi.mock("./TaskWorkspacePanels", () => ({
  TaskWorkspacePanels: (props: { readonly renderConversation: (panel: object) => ReactNode }) =>
    props.renderConversation({ controls: null }),
}));
vi.mock("./TaskConversation", () => ({
  TaskConversation: (props: {
    readonly task: { readonly title: string };
    readonly chrome: NonNullable<typeof engine.chrome>;
    readonly draft?: ReactNode;
  }) => {
    engine.chrome = props.chrome;
    return (
      <section>
        <h2>{props.task.title}</h2>
        {props.draft}
      </section>
    );
  },
}));
vi.mock("./SharedBoard", () => ({ SharedTaskAllocation: () => null }));
vi.mock("../ui/dialog", () => ({
  Dialog: () => null,
  DialogHeader: () => null,
  DialogPanel: () => null,
  DialogPopup: () => null,
  DialogTitle: () => null,
}));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: (props: { children: ReactNode }) => props.children,
  useSidebar: () => ({ isMobile: false, setOpen: () => {}, setOpenMobile: () => {} }),
}));

let renderer: ReactTestRenderer;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(() => renderer?.unmount());
});
it.each([
  { by: "full auto", fullAuto: null, name: null, since: null },
  {
    by: "full auto, turned on by Alex at 2026-10-19T10:00:00Z",
    fullAuto: null,
    name: "Alex",
    since: "2026-10-19T10:00:00Z",
  },
  {
    by: "full auto, turned on by Alex at oops",
    fullAuto: { by: "Sam", since: "2026-10-19T11:00:00Z" },
    name: "Sam",
    since: "2026-10-19T11:00:00Z",
  },
])(
  "shows a Full auto badge with known attribution only: $by",
  async ({ by, fullAuto, name, since }) => {
    await act(() => {
      renderer = create(<FullAutoAttribution entry={{ by, fullAuto }} />);
    });
    expect(renderer.root.findByType("strong").props.children).toBe("Full auto");
    const output = JSON.stringify(renderer.toJSON());
    if (name) expect(output).toContain(`turned on by ${name}`);
    else expect(output).not.toContain("turned on by");
    if (since)
      expect(output).toContain(
        new Date(since).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
  },
);
it("omits the badge for ordinary actors", async () => {
  await act(() => {
    renderer = create(<FullAutoAttribution entry={{ by: "Sam", fullAuto: null }} />);
  });
  expect(renderer.toJSON()).toBeNull();
});
it("opens a draft's editor as the centre of the task's page, inside the board task it belongs to", async () => {
  read.body = { id: "t9", number: 9, title: "Draft", state: "draft", card: { id: "t9" } };
  await act(() => {
    renderer = create(
      <TaskWorkspace
        environmentId={null}
        taskId="t9"
        from="Board"
        onClose={() => {}}
        onOpenTask={() => {}}
      />,
    );
  });
  const centre = renderer.root.findByType("section");
  expect(centre.findByType("h2").props.children).toBe("Draft");
  expect(centre.findByType("p").props.children).toBe("Editor for t9 framed in board task t9");
});

it("sends what is written to a closed task to the engine, and shows its refusal as a toast", async () => {
  read.body = { id: "t4", number: 4, title: "Done", state: "closed", card: { id: "t4" } };
  engine.act.mockResolvedValueOnce({
    ok: false,
    why: "The task is closed.",
    problems: [],
    status: 409,
  } as never);
  await act(() => {
    renderer = create(
      <TaskWorkspace
        environmentId={null}
        taskId="t4"
        from="Board"
        onClose={() => {}}
        onOpenTask={() => {}}
      />,
    );
  });
  const steer = engine.chrome?.steer;
  expect(steer).toBeTypeOf("function");
  await expect(act(() => steer!("One more thing"))).resolves.toBe(false);
  expect(engine.act).toHaveBeenLastCalledWith("/api/tasks/t4/steer", {
    text: "One more thing",
    seat: null,
    by: "Sam",
  });
  expect(engine.toast).toHaveBeenCalledWith({
    type: "error",
    title: "The task did not take your message",
    description: "The task is closed.",
  });
});

it.each([
  { state: "approved", lane: "implementation" },
  { state: "merged", lane: "implementation" },
  { state: "pr-open", lane: "implementation" },
  { state: "ready", lane: "completed" },
])(
  "hands what is written to a task the engine finished ($state, $lane) to the engine",
  async ({ state, lane }) => {
    read.body = { id: "t6", number: 6, title: "Done", state, lane, card: { id: "t6", lane } };
    engine.chrome = null as typeof engine.chrome;
    await act(() => {
      renderer = create(
        <TaskWorkspace
          environmentId={null}
          taskId="t6"
          from="Board"
          onClose={() => {}}
          onOpenTask={() => {}}
        />,
      );
    });
    expect(engine.chrome?.steer).toBeTypeOf("function");
  },
);

it("leaves an open task's messages to its thread, as turns", async () => {
  read.body = { id: "t5", number: 5, title: "Open", state: "ready", card: { id: "t5" } };
  await act(() => {
    renderer = create(
      <TaskWorkspace
        environmentId={null}
        taskId="t5"
        from="Board"
        onClose={() => {}}
        onOpenTask={() => {}}
      />,
    );
  });
  expect(engine.chrome?.steer).toBeUndefined();
});
