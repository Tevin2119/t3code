import { EnvironmentId } from "@t3tools/contracts";
import { act } from "../../../test/act";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { parseTask } from "../../lib/delivery";
import { replyDraftKey, useDeliveryReplyDrafts } from "../../state/deliveryReplyDrafts";
import { TaskComposer } from "./TaskComposer";

const mock = vi.hoisted(() => ({ action: vi.fn(), target: vi.fn(), sent: vi.fn() }));
vi.mock("../../state/delivery", () => ({
  usePersonName: () => "Sam",
  useDeliveryAct: () => mock.action,
}));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "enter" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/badge", () => ({ Badge: "strong" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "div",
  TooltipPopup: "span",
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
}));
vi.mock("../ui/popover", () => ({ Popover: "div", PopoverTrigger: "span", PopoverPopup: "div" }));
vi.mock("./taskFiles", () => ({
  AttachButton: "button",
  FilesInTransit: () => null,
  TaskFileList: () => null,
  useTaskUploads: () => ({ transit: [], send: vi.fn(), dismiss: vi.fn() }),
  useFileIntake: () => ({ over: false, handlers: {} }),
}));
const env = EnvironmentId.make("composer-test");
const question = (seq: number) => ({
  id: `q${seq}`,
  seq,
  kind: "question",
  state: "open",
  by: "Lead",
  text: `Question ${seq}`,
});
const task = (closed = false) =>
  parseTask({
    id: "composer-task",
    number: 1,
    title: "Task",
    card: {},
    state: "intake",
    questions: closed ? [] : [question(1), question(2)],
    timeline: [question(1), question(2)],
  })!;
const first = task().timeline[0]!;
let renderer: ReactTestRenderer;
const view = (closed = false) => (
  <TaskComposer
    environmentId={env}
    task={task(closed)}
    replyTo={first}
    onReplyTo={mock.target}
    onReplySent={mock.sent}
    onSent={() => {}}
    expanded
    onExpandedChange={() => {}}
  />
);
const send = () =>
  renderer.root.findAllByType("button").find((node) => node.props["data-task-send"] !== undefined)!;
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    }),
  );
  useDeliveryReplyDrafts.setState({ drafts: {}, pending: {} });
  mock.action.mockReset();
  mock.target.mockReset();
  mock.sent.mockReset();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
async function mountAndType() {
  await act(() => {
    renderer = create(view());
  });
  await act(() =>
    renderer.root
      .findByType("textarea")
      .props.onChange({ target: { value: "Answer the older question" } }),
  );
}
it("sends the selected question even when a newer question is waiting", async () => {
  await mountAndType();
  mock.action.mockResolvedValue({ ok: true });
  await act(() => send().props.onClick());
  expect(mock.action).toHaveBeenCalledWith("/api/tasks/composer-task/messages", {
    kind: "answer",
    replyTo: 1,
    text: "Answer the older question",
    files: [],
    by: "Sam",
  });
});
it("keeps a closed target's draft after remount and never sends it as a message", async () => {
  await mountAndType();
  await act(() => renderer.unmount());
  await act(() => {
    renderer = create(view(true));
  });
  expect(renderer.root.findByType("textarea").props.value).toBe("Answer the older question");
  expect(send().props.disabled).toBe(true);
  await act(() => send().props.onClick());
  expect(mock.action).not.toHaveBeenCalled();
});
it("persists an uncertain receipt and blocks replay after remount", async () => {
  await mountAndType();
  mock.action.mockResolvedValue({ ok: false, status: null, why: "Connection lost" });
  await act(() => send().props.onClick());
  await act(() => renderer.unmount());
  await act(() => {
    renderer = create(view());
  });
  expect(
    useDeliveryReplyDrafts.getState().drafts[replyDraftKey(env, "composer-task", 1)]?.uncertain,
  ).toBe(true);
  expect(send().props.disabled).toBe(true);
  await act(() => send().props.onClick());
  expect(mock.action).toHaveBeenCalledTimes(1);
});

it("locks editing during a send and acknowledges only the original question", async () => {
  await mountAndType();
  let complete!: (value: unknown) => void;
  mock.action.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(() => send().props.onClick());
  expect(renderer.root.findByType("textarea").props.disabled).toBe(true);
  await act(() =>
    renderer.update(
      <TaskComposer
        environmentId={env}
        task={task()}
        replyTo={task().timeline[1]!}
        onReplyTo={mock.target}
        onReplySent={mock.sent}
        onSent={() => {}}
        expanded
        onExpandedChange={() => {}}
      />,
    ),
  );
  await act(() => complete({ ok: true }));
  expect(mock.sent).toHaveBeenCalledWith(1);
  expect(mock.target).not.toHaveBeenCalled();
});
it("keeps a definitively rejected reply editable", async () => {
  await mountAndType();
  mock.action.mockResolvedValue({ ok: false, status: 409, why: "Another answer is pending" });
  await act(() => send().props.onClick());
  expect(renderer.root.findByType("textarea").props.value).toBe("Answer the older question");
  expect(renderer.root.findByType("textarea").props.disabled).toBe(false);
  expect(
    useDeliveryReplyDrafts.getState().drafts[replyDraftKey(env, "composer-task", 1)]?.uncertain,
  ).toBe(false);
});
