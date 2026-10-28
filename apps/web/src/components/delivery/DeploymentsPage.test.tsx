import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { act } from "../../../test/render";
import { DeploymentsPage } from "./DeploymentsPage";

const mock = vi.hoisted(() => ({
  allowed: true,
  action: vi.fn(),
  refresh: vi.fn(),
  snapshot: {} as unknown,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mock.allowed }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../state/delivery", () => ({
  deliveryEnvironment: { act: { permissionAtom: () => null } },
  useDeliveryEnvironmentId: () => "host",
  useDeliveryEnabled: () => true,
  useDeliveryAct: () => mock.action,
  useDeliveryRead: (_env: string, path: string) => ({
    body:
      path === "/api/health"
        ? {
            approvalWindow: {
              open: true,
              windows: [{ by: "Sam", expiresAt: "2026-10-28T10:10:00Z" }],
            },
          }
        : mock.snapshot,
    error: null,
    isPending: false,
    readAt: "2026-10-28T10:00:00Z",
    refresh: mock.refresh,
  }),
  useStaleReading: () => false,
  usePersonName: () => "Sam",
  useBoardStore: (select: (state: unknown) => unknown) =>
    select({ setPerson: vi.fn(), setDeliveryEnvironment: vi.fn() }),
}));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./EnvironmentPicker", () => ({ EnvironmentPicker: "environment-picker" }));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "checkbox" }));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectItem: "option",
  SelectPopup: "select-popup",
  SelectTrigger: "select-trigger",
  SelectValue: "select-value",
}));
vi.mock("../ui/dialog", () => ({
  Dialog: "dialog",
  DialogPopup: "dialog-popup",
  DialogPanel: "section",
  DialogHeader: "header",
  DialogTitle: "h2",
  DialogDescription: "p",
  DialogFooter: "footer",
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

async function setup() {
  mock.allowed = true;
  mock.action.mockReset().mockResolvedValue({ ok: true });
  mock.refresh.mockReset();
  mock.snapshot = {
    version: 1,
    projects: [],
    candidates: [],
    repositories: [
      {
        id: "repo",
        title: "Repository",
        path: "/repo",
        defaultBase: "main",
        branches: ["main"],
        kind: "git",
        ok: true,
      },
    ],
    capabilities: { engine: true, command: true },
  };
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(<DeploymentsPage />);
  });
  return {
    renderer,
    button: (label: string) =>
      renderer.root.findAllByType("button").find((node) => node.children.join("") === label)!,
    async [Symbol.asyncDispose]() {
      await act(() => renderer.unmount());
    },
  };
}

it("reads without discovering automatically and disables mutation controls without permission", async () => {
  await using view = await setup();
  expect(mock.action).not.toHaveBeenCalled();
  mock.allowed = false;
  await act(() => view.renderer.update(<DeploymentsPage />));
  expect(view.button("Add deployment").props.disabled).toBe(true);
  expect(view.button("Discover commits").props.disabled).toBe(true);
});

async function confirmWithKey(view: Awaited<ReturnType<typeof setup>>) {
  // The mocked health reports an open approval window for Sam; it must not replace the key.
  expect(view.button("Confirm").props.disabled).toBe(true);
  await act(() =>
    view.renderer.root
      .findAllByType("input")
      .find((node) => node.props.type === "password")!
      .props.onChange({ target: { value: "passphrase" } }),
  );
  expect(view.button("Confirm").props.disabled).toBe(false);
  await act(async () => view.button("Confirm").props.onClick());
}

it("requires full-auto consent, uses listed repository and branch, and submits through approval", async () => {
  await using view = await setup();
  await act(() => view.button("Add deployment").props.onClick());
  const selects = () => view.renderer.root.findAllByType("select");
  await act(() => selects()[0]!.props.onValueChange("repo"));
  await act(() => selects()[3]!.props.onValueChange("full-auto"));
  expect(view.button("Review settings").props.disabled).toBe(true);
  await act(() => view.renderer.root.findByType("checkbox" as never).props.onCheckedChange(true));
  expect(view.button("Review settings").props.disabled).toBe(false);
  await act(() => view.button("Review settings").props.onClick());
  expect(mock.action).not.toHaveBeenCalled();
  await confirmWithKey(view);
  expect(mock.action).toHaveBeenCalledWith("/api/deployments/projects", {
    repository: "repo",
    branch: "main",
    environment: "production",
    mode: "full-auto",
    adapter: "engine",
    confirmed: true,
    by: "Sam",
    key: "passphrase",
  });
  expect(mock.refresh).toHaveBeenCalled();
});

it("preserves a saved environment and command arrays when editing", async () => {
  await using view = await setup();
  const commands = {
    qualify: ["npm", "test"],
    deploy: ["npm", "run", "deploy"],
    verify: ["npm", "run", "verify"],
  };
  mock.snapshot = {
    version: 1,
    projects: [
      {
        id: "project",
        repository: "repo",
        title: "Repository",
        branch: "main",
        environment: "staging",
        mode: "manual",
        adapter: "command",
        commands,
        latestCommit: null,
        liveCommit: null,
      },
    ],
    candidates: [],
    repositories: [
      {
        id: "repo",
        title: "Repository",
        path: "/repo",
        defaultBase: null,
        branches: ["main"],
        kind: "git",
        ok: true,
      },
    ],
    capabilities: { engine: true, command: true },
  };
  await act(() => view.renderer.update(<DeploymentsPage />));
  await act(() => view.button("Configure").props.onClick());
  const environment = view.renderer.root.findAllByType("select")[2]!;
  expect(environment.props.value).toBe("staging");
  expect(environment.props.items.map((item: { value: string }) => item.value)).toEqual([
    "development",
    "staging",
    "production",
  ]);
  expect(JSON.parse(view.renderer.root.findByType("textarea").props.value)).toEqual(commands);
  await act(() =>
    view.renderer.root.findByType("textarea").props.onChange({ target: { value: "" } }),
  );
  await act(() => view.button("Review settings").props.onClick());
  await confirmWithKey(view);
  expect(mock.action).toHaveBeenCalledWith("/api/deployments/projects", {
    repository: "repo",
    branch: "main",
    environment: "staging",
    mode: "manual",
    adapter: "command",
    commands,
    by: "Sam",
    key: "passphrase",
  });
});

it("shows a queue persistence fault and disables changes even with an empty queue", async () => {
  await using view = await setup();
  mock.snapshot = { ...(mock.snapshot as object), problem: "Deployment state could not be saved." };
  await act(() => view.renderer.update(<DeploymentsPage />));
  expect(view.renderer.root.findByProps({ role: "alert" }).children.join("")).toContain(
    "Deployment state could not be saved.",
  );
  expect(view.button("Add deployment").props.disabled).toBe(true);
  expect(view.button("Discover commits").props.disabled).toBe(true);
});
