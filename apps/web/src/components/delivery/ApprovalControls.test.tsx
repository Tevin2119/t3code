import { EnvironmentId } from "@t3tools/contracts";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { act } from "../../../test/render";
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
let sidebar: boolean;
const view = () => (
  <ApprovalControls
    sidebar={sidebar}
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
  const warning = find("data-full-auto-warning").props.children;
  for (const fact of [
    "engine signs off by itself",
    "go straight to pull requests",
    "stays on until you turn it off",
    "merges, closes or moves work",
  ])
    expect(warning).toContain(fact);
  await act(() => find("data-full-auto-continue").props.onClick());
}
beforeEach(() => {
  mock.action.mockReset().mockResolvedValue({ ok: true });
  mock.refresh.mockClear();
  mock.person = "Sam";
  mock.personRead.mockClear();
  input = { value: "" };
  error = null;
  sidebar = false;
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
  expect(renderer.root.findAllByProps({ "data-full-auto-off": true })).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain("Alex");
  expect(JSON.stringify(renderer.toJSON())).toContain("since");
  await act(async () => find("data-approval-end").props.onClick());
  await act(async () => renderer.root.findByType("switch").props.onCheckedChange(false));
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
it("disables the off switch when no person is set", async () => {
  mock.person = "";
  body = { fullAuto: { on: true, by: "Alex", since: "2026-10-19T09:00:00Z" } };
  await render();
  expect(renderer.root.findByType("switch").props.disabled).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain("Set your name");
  await act(async () => renderer.root.findByType("switch").props.onCheckedChange(false));
  expect(mock.action).not.toHaveBeenCalled();
});

it("hides an expired window without hiding the supported auto switch", async () => {
  body.approvalWindow = {
    open: true,
    windows: [{ by: "Sam", expiresAt: "2026-10-19T09:59:00Z" }],
  };
  await render();
  expect(renderer.root.findAllByProps({ "data-approval-end": true })).toHaveLength(0);
  expect(renderer.root.findByType("switch").props.checked).toBe(false);
});

it("prevents activation if the name is removed during the passphrase step", async () => {
  await render();
  await open();
  input.value = "one-use";
  await act(() => renderer.root.findByType("input").props.onChange({ target: input }));
  mock.person = "";
  await act(() => renderer.update(view()));
  expect(find("data-full-auto-on").props.disabled).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain("Set your name");
  await act(() => find("data-full-auto-on").props.onClick());
  expect(mock.action).not.toHaveBeenCalled();
});

it.each([false, true])(
  "keeps the off switch engine-only for another person's window (sidebar=%s)",
  async (value) => {
    sidebar = value;
    body.approvalWindow = {
      open: true,
      windows: [{ by: "Alex", expiresAt: "2026-10-19T10:10:00Z" }],
    };
    await render();
    if (sidebar) expect(renderer.toJSON()).toBeNull();
    else expect(renderer.root.findByType("switch").props.checked).toBe(false);
  },
);
it.each([
  { by: "Alex", expiresAt: "2026-10-19T10:10:00Z" },
  { by: "Sam", expiresAt: "2026-10-19T10:00:00Z" },
])("renders no sidebar wrapper without a current window: %j", async (window) => {
  sidebar = true;
  body = { approvalWindow: { open: true, windows: [window] } };
  await render();
  expect(renderer.toJSON()).toBeNull();
});
it.each([
  { by: "", since: null },
  { by: "   ", since: "oops" },
  { by: "Alex", since: "oops" },
  { by: "", since: "2026-10-19T09:00:00Z" },
])("turns auto off with the switch under partial attribution %j", async (attribution) => {
  body = { fullAuto: { on: true, ...attribution } };
  await render();
  const output = JSON.stringify(renderer.toJSON());
  expect(output).toContain("Full auto ");
  expect(renderer.root.findByType("switch").props.checked).toBe(true);
  expect(output).not.toContain("Turned on by ,");
  if (!attribution.by.trim()) expect(output).not.toContain("Turned on by");
  if (attribution.since === "oops" || attribution.since === null)
    expect(output).not.toContain("since ");
  await act(async () => renderer.root.findByType("switch").props.onCheckedChange(false));
  expect(mock.action).toHaveBeenCalledExactlyOnceWith("/api/engine/auto/off", { by: "Sam" });
});
it("shows the supported off switch in the sidebar without a window", async () => {
  sidebar = true;
  await render();
  expect(renderer.root.findByType("switch").props.checked).toBe(false);
});

it("shows only the label and switch for full auto in the sidebar", async () => {
  sidebar = true;
  body = { fullAuto: { on: true, by: "Alex", since: "2026-10-19T09:00:00Z" } };
  await render();
  const output = JSON.stringify(renderer.toJSON());
  expect(output).toContain("Full auto ");
  expect(renderer.root.findByProps({ role: "status" }).props.children).toEqual([
    "Full auto ",
    "on",
  ]);
  expect(renderer.root.findByType("switch").props.checked).toBe(true);
  expect(renderer.root.findAllByProps({ "data-full-auto-off": true })).toHaveLength(0);
  expect(renderer.root.findAllByType("button")).toHaveLength(0);
  expect(output).not.toContain("Turned on by");
  expect(output).not.toContain("since");
  await act(async () => renderer.root.findByType("switch").props.onCheckedChange(false));
  expect(mock.action).toHaveBeenCalledExactlyOnceWith("/api/engine/auto/off", { by: "Sam" });
});
