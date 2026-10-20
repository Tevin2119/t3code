import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ApprovalControls } from "./ApprovalControls";

const mock = vi.hoisted(() => ({
  action: vi.fn(),
  refresh: vi.fn(),
  person: "Sam",
  personRead: vi.fn(),
}));
vi.mock("../../state/delivery", () => ({
  usePersonName: () => {
    mock.personRead();
    return mock.person;
  },
  useMinuteClock: () => Date.parse("2026-10-19T10:00:00Z"),
  useDeliveryAct: () => mock.action,
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
vi.mock("../ui/switch", () => ({ Switch: "switch" }));
let renderer: ReactTestRenderer;
let input: { value: string };
let body: Record<string, unknown>;
let error: string | null;
const view = () => (
  <ApprovalControls
    environmentId={EnvironmentId.make("env-a")}
    health={{ body, error, refresh: mock.refresh }}
  />
);
const find = (attr: string) => renderer.root.findByProps({ [attr]: true });
async function render() {
  await act(() => {
    renderer = create(view(), {
      createNodeMock: (element) => (element.type === "input" ? input : null),
    });
  });
}
async function open() {
  await act(() => renderer.root.findByType("switch").props.onCheckedChange(true));
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
  expect(JSON.stringify(find("data-full-auto-warning").props.children)).toContain(
    "bypassing approvals",
  );
  await act(() => find("data-full-auto-continue").props.onClick());
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mock.action.mockReset().mockResolvedValue({ ok: true });
  mock.refresh.mockClear();
  mock.person = "Sam";
  mock.personRead.mockClear();
  input = { value: "" };
  error = null;
  body = { fullAuto: { on: false, by: null, since: null } };
});
afterEach(async () => {
  await act(() => renderer?.unmount());
});

it("warns before requesting a fresh key, even with an open approval window", async () => {
  body = {
    fullAuto: { on: false },
    approvalWindow: { open: true, windows: [{ by: "Sam", expiresAt: "2026-10-19T10:10:00Z" }] },
  };
  await render();
  await open();
  input.value = "one-use";
  await act(() => renderer.root.findByType("input").props.onChange({ target: input }));
  await act(async () => find("data-full-auto-on").props.onClick());
  expect(mock.action).toHaveBeenCalledExactlyOnceWith("/api/engine/auto", {
    key: "one-use",
    by: "Sam",
    confirmed: true,
  });
  expect(input.value).toBe("");
  expect(mock.refresh).toHaveBeenCalledOnce();
  await open();
  expect(input.value).toBe("");
});

it.each([true, false])(
  "drops duplicate activation and clears the key after settlement (ok=%s)",
  async (ok) => {
    let settle: (value: unknown) => void = () => {};
    mock.action.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    await render();
    await open();
    input.value = "one-use";
    await act(() => renderer.root.findByType("input").props.onChange({ target: input }));
    const activate = find("data-full-auto-on").props.onClick;
    await act(() => {
      activate();
      input.value = "second";
      activate();
    });
    expect(mock.action).toHaveBeenCalledTimes(1);
    await act(() => settle({ ok, why: "Refused" }));
    expect(input.value).toBe("");
    if (!ok) expect(renderer.root.findByProps({ role: "alert" }).props.children).toBe("Refused");
    await act(() => renderer.root.findByType("switch").props.onCheckedChange(true));
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
  },
);

it.each(["cancel", "dismiss"])("clears on %s and reopens at the warning", async (how) => {
  await render();
  await open();
  input.value = "discard-me";
  await act(() => {
    if (how === "dismiss") renderer.root.findByType("dialog").props.onOpenChange(false);
    else
      renderer.root
        .findAllByType("button")
        .find((button) => button.props.children === "Cancel")!
        .props.onClick();
  });
  expect(input.value).toBe("");
  await act(() => renderer.root.findByType("switch").props.onCheckedChange(true));
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
});

it("ends the window and turns off auto without sending a key", async () => {
  body = {
    fullAuto: { on: true, by: "Alex", since: "2026-10-19T09:00:00Z" },
    approvalWindow: { open: true, windows: [{ by: "Sam", expiresAt: "2026-10-19T10:10:00Z" }] },
  };
  await render();
  expect(JSON.stringify(renderer.toJSON())).toContain("Alex");
  expect(JSON.stringify(renderer.toJSON())).toContain("since");
  await act(async () => find("data-approval-end").props.onClick());
  await act(async () => find("data-full-auto-off").props.onClick());
  expect(mock.action.mock.calls).toEqual([
    ["/api/approval/window/end", { by: "Sam" }],
    ["/api/engine/auto/off", { by: "Sam" }],
  ]);
});

it.each([{}, { fullAuto: { on: "true" } }])(
  "shows nothing for old or malformed capabilities %j",
  async (value) => {
    body = value;
    await render();
    expect(renderer.toJSON()).toBeNull();
  },
);
it("does not show controls from a retained body after a failed reading", async () => {
  error = "offline";
  await render();
  expect(renderer.toJSON()).toBeNull();
});

it("does not call feature hooks for legacy health", async () => {
  body = {};
  await render();
  expect(mock.personRead).not.toHaveBeenCalled();
});
it("disables activation until a passphrase is entered", async () => {
  await render();
  await open();
  expect(find("data-full-auto-on").props.disabled).toBe(true);
  expect(renderer.root.findByType("input").props.value).toBeUndefined();
});
it("disables turn off when the name is missing", async () => {
  mock.person = "";
  body = { fullAuto: { on: true, by: "Alex", since: "2026-10-19T09:00:00Z" } };
  await render();
  expect(find("data-full-auto-off").props.disabled).toBe(true);
  await act(async () => find("data-full-auto-off").props.onClick());
  expect(mock.action).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer.toJSON())).toContain("Set your name");
});
