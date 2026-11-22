import { act, use } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BoardTaskContext } from "./BoardTaskContext";
import { FullAutoAttribution, TaskWorkspace } from "./TaskWorkspace";

const read = vi.hoisted(() => ({ body: null as unknown }));
vi.mock("../ui/badge", () => ({ Badge: "strong" }));
vi.mock("../../state/delivery", () => ({
  usePersonName: () => "Sam",
  useDeliveryAct: () => vi.fn(),
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
vi.mock("./useTaskConversation", () => ({ useTaskConversation: () => ({ open: () => {} }) }));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../../hooks/useLocalStorage", async () => {
  const { useState } = await import("react");
  return { useLocalStorage: (_key: string, initial: unknown) => useState(initial) };
});
// The editor, as it reads the board task it is opened in.
vi.mock("./TaskEditor", () => ({
  TaskEditor: (props: { readonly taskId: string | null }) => {
    const board = use(BoardTaskContext);
    return <p>{`Editor for ${props.taskId} in board task ${board?.taskId}`}</p>;
  },
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
it("opens a draft in the task editor, inside the board task it belongs to", async () => {
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
  expect(renderer.toJSON()).toEqual(
    expect.objectContaining({ children: ["Editor for t9 in board task t9"] }),
  );
});
