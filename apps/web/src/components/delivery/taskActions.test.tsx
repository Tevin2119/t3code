import { EnvironmentId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { DeliveryCard } from "../../lib/delivery";
import { useTaskActions } from "./taskActions";

const mock = vi.hoisted(() => ({
  action: vi.fn(),
  refresh: vi.fn(),
  setPerson: vi.fn(),
  body: null as unknown,
  error: null as string | null,
  read: vi.fn(),
}));
vi.mock("../../state/delivery", () => ({
  usePersonName: () => "Sam",
  useMinuteClock: () => Date.parse("2026-10-19T10:00:00Z"),
  useDeliveryAct: () => mock.action,
  useDeliveryRead: (...args: unknown[]) => {
    mock.read(...args);
    return { body: mock.body, error: mock.error, refresh: mock.refresh };
  },
  useBoardStore: (select: (state: { setPerson: typeof mock.setPerson }) => unknown) =>
    select({ setPerson: mock.setPerson }),
}));
vi.mock("../ui/dialog", () => ({
  Dialog: "dialog",
  DialogPopup: "dialog-popup",
  DialogPanel: "section",
  DialogHeader: "header",
  DialogTitle: "h2",
  DialogFooter: "footer",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
const target = {
  id: "task-1",
  title: "Keep candidate",
  number: 1,
  run: { id: "run-1", candidate: "abc123" },
  partOf: null,
  parts: [],
  publication: null,
} as unknown as DeliveryCard;
let actions: ReturnType<typeof useTaskActions>;
let renderer: ReactTestRenderer;
function Probe() {
  const value = useTaskActions(EnvironmentId.make("env-a"), { onDone: () => {} });
  useLayoutEffect(() => {
    actions = value;
  }, [value]);
  return value.dialog;
}
const openWindow = {
  approvalWindow: { open: true, windows: [{ by: "Sam", expiresAt: "2026-10-19T10:10:00Z" }] },
};
const password = () => renderer.root.findAllByProps({ type: "password" });
const submit = () => renderer.root.findAllByType("button").at(-1)!;
async function open(action = "approve") {
  await act(() => {
    renderer = create(<Probe />);
  });
  await act(() => actions.run(target, action));
}
async function refresh() {
  await act(() => renderer.update(<Probe />));
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mock.action.mockReset().mockResolvedValue({ ok: true });
  mock.refresh.mockClear();
  mock.read.mockClear();
  mock.body = openWindow;
  mock.error = null;
});
afterEach(async () => {
  await act(() => renderer?.unmount());
});

it.each(["approve", "publish"])("omits the key property for keyless %s", async (action) => {
  await open(action);
  expect(password()).toHaveLength(0);
  await act(async () => submit().props.onClick());
  expect(mock.action.mock.calls).toEqual(
    action === "approve"
      ? [["/api/runs/run-1/decide", { decision: "approve", candidate: "abc123", actor: "Sam" }]]
      : [["/api/tasks/task-1/publish", { by: "Sam", candidate: "abc123" }]],
  );
  expect(mock.refresh).toHaveBeenCalledTimes(2);
});
it.each([{}, { approvalWindow: { open: "true" } }, null])(
  "keeps keyed sign-off for absent or invalid window %j",
  async (body) => {
    mock.body = body;
    await open();
    await act(() => password()[0]!.props.onChange({ target: { value: "one-use" } }));
    await act(async () => submit().props.onClick());
    expect(mock.action).toHaveBeenCalledWith("/api/runs/run-1/decide", {
      decision: "approve",
      candidate: "abc123",
      actor: "Sam",
      key: "one-use",
    });
  },
);
it("restores the key in place on refusal, preserving notes and candidate", async () => {
  mock.action.mockResolvedValueOnce({ ok: false, why: "Window ended", status: 403 });
  await open("reject");
  await act(() =>
    renderer.root.findByType("textarea").props.onChange({ target: { value: "Keep these notes" } }),
  );
  await act(async () => submit().props.onClick());
  expect(mock.refresh).toHaveBeenCalledTimes(2);
  expect(password()).toHaveLength(1);
  expect(renderer.root.findByType("textarea").props.value).toBe("Keep these notes");
  expect(JSON.stringify(renderer.toJSON())).toContain("Window ended");
  await act(() => password()[0]!.props.onChange({ target: { value: "fresh-key" } }));
  await act(async () => submit().props.onClick());
  expect(mock.action).toHaveBeenLastCalledWith("/api/runs/run-1/decide", {
    decision: "reject",
    candidate: "abc123",
    actor: "Sam",
    key: "fresh-key",
    notes: "Keep these notes",
  });
});
it("tracks window opening and ending while the same dialog remains open", async () => {
  mock.body = {};
  await open();
  expect(password()).toHaveLength(1);
  mock.body = openWindow;
  await refresh();
  expect(password()).toHaveLength(0);
  mock.body = { approvalWindow: { open: false } };
  await refresh();
  expect(password()).toHaveLength(1);
});
it("requires a key after a failed health reading even with a retained open body", async () => {
  mock.error = "offline";
  await open();
  expect(password()).toHaveLength(1);
});
it("keeps artifact acceptance keyed inside an approval window", async () => {
  await open("accept-artifacts");
  expect(password()).toHaveLength(1);
  await act(() => password()[0]!.props.onChange({ target: { value: "artifact-key" } }));
  await act(async () => submit().props.onClick());
  expect(mock.action).toHaveBeenCalledWith("/api/tasks/task-1/control", {
    action: "accept-artifacts",
    run: "run-1",
    by: "Sam",
    key: "artifact-key",
  });
});

it.each(
  ["approve", "publish"].flatMap((action) =>
    [403, 409, null].map((status) => ({ action, status })),
  ),
)("reasks only for a 403 after $action fails with $status", async ({ action, status }) => {
  mock.action.mockResolvedValueOnce({ ok: false, why: "Refused", status });
  await open(action);
  await act(async () => submit().props.onClick());
  expect(password()).toHaveLength(status === 403 ? 1 : 0);
});
it("follows the name edited inside the dialog", async () => {
  await open();
  expect(password()).toHaveLength(0);
  await act(() =>
    renderer.root
      .findByProps({ placeholder: "Your name" })
      .props.onChange({ target: { value: "Alex" } }),
  );
  expect(password()).toHaveLength(1);
  expect(submit().props.disabled).toBe(true);
});
it("never uses someone else's window", async () => {
  mock.body = {
    approvalWindow: { open: true, windows: [{ by: "Alex", expiresAt: "2026-10-19T10:10:00Z" }] },
  };
  await open();
  expect(password()).toHaveLength(1);
});

it("requires the passphrase when the actor's reported window has expired", async () => {
  mock.body = {
    approvalWindow: {
      open: true,
      windows: [{ by: "Sam", expiresAt: "2026-10-19T09:59:00Z" }],
    },
  };
  await open();
  expect(password()).toHaveLength(1);
  expect(submit().props.disabled).toBe(true);
});

it.each([{}, openWindow])("polls faster only with an open sign-off dialog: %j", async (body) => {
  mock.body = body;
  await act(() => {
    renderer = create(<Probe />);
  });
  expect(mock.read.mock.lastCall?.[1]).toBe("/api/health");
  expect(mock.read.mock.lastCall?.[2]?.pollMs).toBeUndefined();
  expect(mock.refresh).not.toHaveBeenCalled();
  await act(() => actions.run(target, "approve"));
  expect(mock.refresh).toHaveBeenCalledOnce();
  expect(mock.read.mock.lastCall?.[2]?.pollMs).toBe(5000);
  await act(() => renderer.root.findByType("dialog").props.onOpenChange(false));
  expect(mock.read.mock.lastCall?.[2]?.pollMs).toBeUndefined();
});
