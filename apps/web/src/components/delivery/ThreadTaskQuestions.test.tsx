import { EnvironmentId } from "@t3tools/contracts";
import { act } from "../../../test/act";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { parseCards } from "../../lib/delivery";
import { replyDraftKey, useDeliveryReplyDrafts } from "../../state/deliveryReplyDrafts";
import { ThreadTaskQuestions } from "./ThreadTaskQuestions";

const mock = vi.hoisted(() => ({ action: vi.fn(), refresh: vi.fn(), body: null as unknown }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/delivery", () => ({
  usePersonName: () => "Sam",
  useDeliveryAct: () => mock.action,
  useDeliveryRead: () => ({ body: mock.body, error: null, refresh: mock.refresh }),
  deliveryEnvironment: { act: { permissionAtom: () => null } },
}));
vi.mock("@tanstack/react-router", () => ({ Link: "a" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/badge", () => ({ Badge: "strong" }));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));
const env = EnvironmentId.make("env-a");
const cards = parseCards([{ id: "task-a", number: 1, title: "Task" }]);
const question = (seq: number, state = "open") => ({
  id: `m${seq}`,
  seq,
  source: "message",
  kind: "question",
  state,
  by: "planner",
  text: `Question ${seq}`,
});
const task = (answered = false) => ({
  id: "task-a",
  number: 1,
  title: "Task",
  card: {},
  state: "intake",
  questions: answered ? [] : [{ seq: 1 }, { seq: 2 }],
  timeline: answered
    ? [
        question(1, "answered"),
        question(2, "closed"),
        {
          id: "m3",
          seq: 3,
          source: "message",
          kind: "answer",
          replyTo: 1,
          state: "applied",
          by: "full auto",
          text: "Keep it",
          revision: 2,
        },
      ]
    : [question(1), question(2)],
});
let renderer: ReactTestRenderer;
const view = () => <ThreadTaskQuestions environmentId={env} tasks={cards} />;
const buttons = () => renderer.root.findAllByType("button");
const button = (text: string) => buttons().find((entry) => entry.props.children === text)!;
const key = replyDraftKey(env, "task-a", 1);
async function mount() {
  await act(() => {
    renderer = create(view());
  });
}
async function edit(text: string) {
  await act(() =>
    buttons()
      .find(
        (entry) => Array.isArray(entry.props.children) && entry.props.children[0] === "Reply to Q",
      )!
      .props.onClick(),
  );
  await act(() => renderer.root.findByType("textarea").props.onChange({ target: { value: text } }));
}
beforeEach(() => {
  useDeliveryReplyDrafts.setState({ drafts: {}, pending: {} });
  mock.body = task();
  mock.action.mockReset();
  mock.refresh.mockReset();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
});

it("keeps a losing draft and shows the winning answer and sibling closure after refresh", async () => {
  await mount();
  await edit("My answer");
  mock.action.mockResolvedValue({ ok: false, status: 409, why: "Question is no longer waiting" });
  await act(() => button("Send reply").props.onClick());
  expect(mock.action).toHaveBeenCalledWith("/api/tasks/task-a/messages", {
    kind: "answer",
    replyTo: 1,
    by: "Sam",
    text: "My answer",
  });
  mock.body = task(true);
  await act(() => renderer.update(view()));
  expect(renderer.root.findByType("textarea").props.value).toBe("My answer");
  expect(renderer.root.findByType("textarea").props.readOnly).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain("Full auto");
  expect(JSON.stringify(renderer.toJSON())).toContain("Closed by the engine");
  expect(button("Send reply")).toBeUndefined();
});
it("guards overlapping submits and records receipt without claiming the team resumed", async () => {
  await mount();
  await edit("Use the existing thread");
  let resolve!: (result: unknown) => void;
  mock.action.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const send = button("Send reply").props.onClick;
  await act(() => {
    send();
    send();
  });
  expect(mock.action).toHaveBeenCalledTimes(1);
  await act(() => resolve({ ok: true, body: task(true) }));
  expect(useDeliveryReplyDrafts.getState().drafts[key]).toBeUndefined();
  expect(JSON.stringify(renderer.toJSON())).toContain(
    "Answer recorded. Refreshing its application state.",
  );
});
it("preserves uncertain receipts across navigation and never automatically replays them", async () => {
  await mount();
  await edit("Keep my draft");
  mock.action.mockResolvedValue({ ok: false, status: null, why: "Disconnected" });
  await act(() => button("Send reply").props.onClick());
  await act(() => renderer.unmount());
  await mount();
  expect(renderer.root.findByType("textarea").props.value).toBe("Keep my draft");
  expect(button("Send reply").props.disabled).toBe(true);
  expect(mock.action).toHaveBeenCalledTimes(1);
  expect(useDeliveryReplyDrafts.getState().drafts[key]?.uncertain).toBe(true);
});
it("keeps per-question drafts isolated from other tasks and environments", async () => {
  await mount();
  await edit("Older question draft");
  await act(() =>
    useDeliveryReplyDrafts
      .getState()
      .update(replyDraftKey(env, "task-a", 2), { text: "New question draft" }),
  );
  expect(renderer.root.findAllByType("textarea").map((entry) => entry.props.value)).toEqual([
    "Older question draft",
    "New question draft",
  ]);
  expect(
    useDeliveryReplyDrafts.getState().drafts[replyDraftKey("other-env", "task-a", 1)],
  ).toBeUndefined();
  expect(
    useDeliveryReplyDrafts.getState().drafts[replyDraftKey(env, "other-task", 1)],
  ).toBeUndefined();
});

it("retains a definitely rejected draft and allows an explicit corrected retry", async () => {
  await mount();
  await edit("Keep this text");
  mock.action.mockResolvedValue({ ok: false, status: 400, why: "Invalid answer" });
  await act(() => button("Send reply").props.onClick());
  expect(renderer.root.findByType("textarea").props.value).toBe("Keep this text");
  expect(button("Send reply").props.disabled).toBe(false);
  expect(useDeliveryReplyDrafts.getState().drafts[key]?.uncertain).toBe(false);
});

it("offers a human reply while a recorded automatic answer is waiting", async () => {
  const body = task();
  mock.body = {
    ...body,
    timeline: [
      ...body.timeline,
      {
        id: "m3",
        seq: 3,
        source: "message",
        kind: "answer",
        replyTo: 1,
        state: "received",
        by: "full auto",
        text: "Automatic draft",
      },
    ],
  };
  await mount();
  await edit("I will take over");
  expect(button("Send reply").props.disabled).toBe(false);
  mock.action.mockResolvedValue({ ok: true, body: task(true) });
  await act(() => button("Send reply").props.onClick());
  expect(mock.action).toHaveBeenCalledWith("/api/tasks/task-a/messages", {
    kind: "answer",
    replyTo: 1,
    by: "Sam",
    text: "I will take over",
  });
});
it("shows a later matching engine answer beside the retained uncertain draft", async () => {
  await mount();
  await edit("Keep it");
  mock.action.mockResolvedValue({ ok: false, status: null, why: "Disconnected" });
  await act(() => button("Send reply").props.onClick());
  const body = task(true);
  mock.body = {
    ...body,
    timeline: body.timeline.map((entry) =>
      entry.kind === "answer" ? { ...entry, by: "Sam" } : entry,
    ),
  };
  await act(() => renderer.update(view()));
  expect(JSON.stringify(renderer.toJSON())).toContain("matching answer from you");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("This reply cannot be sent.");
  expect(renderer.root.findByType("textarea").props.value).toBe("Keep it");
  expect(mock.action).toHaveBeenCalledTimes(1);
});
