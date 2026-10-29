import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { act } from "../../../test/render";
import { DeploymentsPage } from "./DeploymentsPage";
import { ADD_REPOSITORY, RepositoryPicker } from "./RepositoryPicker";

const mock = vi.hoisted(() => ({
  allowed: true,
  action: vi.fn(),
  refresh: vi.fn(),
  snapshot: {} as unknown,
  projects: [] as unknown[],
}));
vi.mock("../../state/entities", () => ({ useProjects: () => mock.projects }));
vi.mock("./EnginePanel", () => ({ EnginePanel: "engine-panel" }));
vi.mock("./BoardToolbar", () => ({ useBoardDesktop: () => true }));
vi.mock("./BoardPicker.browse", () => ({ RepositoryBrowse: "repository-browse" }));
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
  SelectButton: "select-button",
}));
vi.mock("../ui/command", async (original) => ({
  ...(await original<typeof import("../ui/command")>()),
  CommandDialog: "command-dialog",
  CommandDialogPopup: "command-dialog-popup",
}));
vi.mock("../CommandPaletteContent", () => ({ CommandPaletteContent: "palette-content" }));
vi.mock("../CommandPaletteResults", () => ({ CommandPaletteResults: "palette-results" }));
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
  mock.projects = [];
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
        engineAdapter: true,
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
  await act(() => view.renderer.root.findByType(RepositoryPicker).props.onChoose("repo"));
  await act(() => selects()[3]!.props.onValueChange("engine"));
  await act(() => selects()[2]!.props.onValueChange("full-auto"));
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
  const environment = view.renderer.root.findAllByType("select")[1]!;
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

const commands = {
  qualify: ["npm", "test"],
  deploy: ["npm", "run", "deploy"],
  verify: ["npm", "run", "verify"],
};
const repositoryRow = (changes: object = {}) => ({
  id: "repo",
  title: "Repository",
  path: "/repo",
  defaultBase: "main",
  branches: ["main"],
  kind: "git",
  ok: true,
  ...changes,
});
const projectRow = (changes: object = {}) => ({
  id: "project",
  repository: "repo",
  title: "Repository",
  branch: "main",
  environment: "production",
  mode: "manual",
  adapter: "command",
  commands,
  latestCommit: null,
  liveCommit: null,
  ...changes,
});
const adapterChoices = (view: Awaited<ReturnType<typeof setup>>) =>
  view.renderer.root
    .findAllByType("select")[3]!
    .props.items.map((item: { value: string }) => item.value);

it("starts new deployments on repository commands and offers the engine only where it can release", async () => {
  await using view = await setup();
  mock.snapshot = { ...(mock.snapshot as object), repositories: [repositoryRow()] };
  await act(() => view.renderer.update(<DeploymentsPage />));
  await act(() => view.button("Add deployment").props.onClick());
  await act(() => view.renderer.root.findByType(RepositoryPicker).props.onChoose("repo"));
  expect(view.renderer.root.findAllByType("select")[3]!.props.value).toBe("command");
  expect(adapterChoices(view)).toEqual(["command"]);
  // Repository commands need their arrays before they can be saved.
  expect(view.button("Review settings").props.disabled).toBe(true);
});

it("registers a T3 project with the engine from the repository list, without a board", async () => {
  await using view = await setup();
  mock.projects = [
    {
      id: "p1",
      environmentId: "host",
      workspaceRoot: "/work/app",
      title: "App",
      repositoryIdentity: null,
    },
  ];
  mock.snapshot = { ...(mock.snapshot as object), repositories: [] };
  mock.action.mockResolvedValueOnce({
    ok: true,
    body: repositoryRow({ id: "app", title: "App", path: "/work/app" }),
  });
  await act(() => view.renderer.update(<DeploymentsPage />));
  await act(() => view.button("Add deployment").props.onClick());
  const repository = () => view.renderer.root.findByType(RepositoryPicker);
  // The field opens T3's palette project list; a row runs its choice.
  const rows = async () => {
    await act(() =>
      view.renderer.root
        .findByProps({ "aria-label": "Repository", size: "default" })
        .props.onClick(),
    );
    return view.renderer.root.findByType("palette-results" as never).props.groups.flatMap(
      (group: {
        items: Array<{
          value: string;
          title: string;
          description?: string;
          run: () => Promise<void>;
        }>;
      }) => group.items,
    );
  };
  const listed = await rows();
  expect(
    listed.map((row: { title: string; description?: string }) => [row.title, row.description]),
  ).toEqual([
    ["App", "/work/app"],
    ["Add a repository by its folder…", undefined],
  ]);
  await act(async () => listed[0]!.run());
  expect(view.renderer.root.findAllByType("palette-results" as never)).toHaveLength(0);
  expect(mock.action).toHaveBeenCalledWith("/api/repositories", {
    path: "/work/app",
    title: "App",
    by: "Sam",
  });
  expect(repository().props.value).toBe("app");
  expect(repository().props.shown).toBe("App");
  expect(view.renderer.root.findAllByType("select")[0]!.props.value).toBe("main");
  expect(mock.refresh).toHaveBeenCalled();
  // Once added, the project is the engine's row and is not offered to add again.
  const again = await rows();
  expect(again.map((row: { value: string }) => row.value)).toEqual(["app", ADD_REPOSITORY]);
  await act(async () => again[1]!.run());
  expect(view.renderer.root.findAllByType("repository-browse" as never)).toHaveLength(1);
});

it("switching a command deployment to the engine sends no commands", async () => {
  await using view = await setup();
  mock.snapshot = {
    ...(mock.snapshot as object),
    projects: [projectRow()],
    repositories: [repositoryRow({ engineAdapter: true })],
  };
  await act(() => view.renderer.update(<DeploymentsPage />));
  await act(() => view.button("Configure").props.onClick());
  await act(() => view.renderer.root.findAllByType("select")[3]!.props.onValueChange("engine"));
  await act(() => view.button("Review settings").props.onClick());
  await confirmWithKey(view);
  expect(mock.action).toHaveBeenCalledWith("/api/deployments/projects", {
    repository: "repo",
    branch: "main",
    environment: "production",
    mode: "manual",
    adapter: "engine",
    by: "Sam",
    key: "passphrase",
  });
});

it("keeps an existing engine deployment's adapter when the repository row does not offer it", async () => {
  await using view = await setup();
  mock.snapshot = {
    ...(mock.snapshot as object),
    projects: [projectRow({ adapter: "engine", commands: null })],
    repositories: [repositoryRow({ engineAdapter: false })],
  };
  await act(() => view.renderer.update(<DeploymentsPage />));
  await act(() => view.button("Configure").props.onClick());
  expect(adapterChoices(view)).toEqual(["command", "engine"]);
  expect(view.button("Review settings").props.disabled).toBe(false);
});

it("warns about missing commands and offers only cancel while the environment is busy", async () => {
  await using view = await setup();
  mock.snapshot = {
    ...(mock.snapshot as object),
    projects: [projectRow({ commands: null, busy: true })],
    candidates: [
      {
        id: "release-1",
        projectId: "project",
        commit: "a".repeat(40),
        baseCommit: null,
        state: "ready",
        subject: "Fix the login form",
        seq: 3,
        createdAt: "2026-10-28T00:00:00Z",
        updatedAt: "2026-10-28T00:00:00Z",
        evidence: null,
        events: [],
      },
    ],
  };
  await act(() => view.renderer.update(<DeploymentsPage />));
  const text = JSON.stringify(view.renderer.toJSON());
  expect(text).toContain("Repository commands are not configured");
  expect(text).toContain("Fix the login form");
  expect(view.button("Deploy")).toBeUndefined();
  expect(view.button("Cancel")).toBeDefined();
});

it("asks for delivery permission without declaring the connection read-only", async () => {
  await using view = await setup();
  mock.allowed = false;
  await act(() => view.renderer.update(<DeploymentsPage />));
  const text = JSON.stringify(view.renderer.toJSON());
  expect(text).toContain("Deployment changes require delivery permission.");
  expect(text).not.toContain("Read-only");
});
