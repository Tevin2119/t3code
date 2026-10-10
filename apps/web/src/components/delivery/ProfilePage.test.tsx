import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ProfilePage } from "./ProfilePage";

interface Project {
  readonly id: string;
  readonly environmentId: string;
  readonly title: string;
  readonly workspaceRoot: string;
}
interface Query {
  readonly data: unknown;
  readonly error: string | null;
  readonly isPending: boolean;
}

// The environment data the picker reads, by environment: projects, the files a
// project search finds, the folders a browse lists, and the files in a folder.
const mock = vi.hoisted(() => ({
  environment: "env-a",
  editable: true,
  revision: 1,
  references: [] as Array<string>,
  os: {} as Record<string, string | undefined>,
  baseDirectory: {} as Record<string, string>,
  projects: [] as Array<Project>,
  projectFiles: {} as Record<string, ReadonlyArray<string>>,
  browse: {} as Record<string, Query>,
  folderFiles: {} as Record<string, ReadonlyArray<{ path: string; kind: string }>>,
  action: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({ name: "mine" }),
}));
vi.mock("../../state/delivery", async (original) => ({
  ...(await original<typeof import("../../state/delivery")>()),
  useDeliveryEnvironmentId: () => mock.environment,
  useDeliveryEnabled: () => true,
  usePersonName: () => "me",
  useDeliveryAct: () => mock.action,
  useDeliveryRead: (_environmentId: string | null, path: string | null) => ({
    body:
      path === "/api/profiles/mine"
        ? {
            profile: "mine",
            name: "mine",
            editable: mock.editable,
            revision: mock.revision,
            seats: [],
            references: mock.references,
          }
        : null,
    error: null,
    isPending: false,
    refresh: () => {},
  }),
}));
vi.mock("../../state/entities", async (original) => ({
  ...(await original<typeof import("../../state/entities")>()),
  useProjects: () => mock.projects,
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironment: (environmentId: string | null) =>
    environmentId === null
      ? null
      : {
          environmentId,
          serverConfig: {
            environment: { platform: { os: mock.os[environmentId] } },
            settings: { addProjectBaseDirectory: mock.baseDirectory[environmentId] ?? "" },
          },
        },
}));
vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: {
    browse: (key: { environmentId: string; input: { partialPath: string } }) => ({
      browse: `${key.environmentId}|${key.input.partialPath}`,
    }),
  },
}));
vi.mock("../../state/query", async (original) => ({
  ...(await original<typeof import("../../state/query")>()),
  useEnvironmentQuery: (atom: { browse?: string } | null) => {
    const found = atom?.browse ? mock.browse[atom.browse] : undefined;
    return {
      data: found?.data ?? null,
      error: found?.error ?? null,
      isPending: found?.isPending ?? false,
      isSuccess: found?.data != null,
      refresh: () => {},
    };
  },
}));
vi.mock("../files/projectFilesQueryState", async (original) => ({
  ...(await original<typeof import("../files/projectFilesQueryState")>()),
  useProjectFilePickerQuery: (environmentId: string, cwd: string, query: string) => ({
    entries: (mock.projectFiles[`${environmentId}|${cwd}`] ?? [])
      .filter((path) => path.toLowerCase().includes(query.trim().toLowerCase()))
      .map((path) => ({ path, kind: "file" })),
    error: null,
    isPending: false,
    matchedQuery: query,
  }),
  useProjectEntriesQuery: (environmentId: string, cwd: string, directoryPath?: string) => {
    const entries = directoryPath === "" ? mock.folderFiles[`${environmentId}|${cwd}`] : undefined;
    return {
      data: entries ? { entries, truncated: false } : null,
      error: entries ? null : "Workspace query failed.",
      isPending: false,
      refresh: () => {},
    };
  },
}));
vi.mock("../../state/server", async (original) => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    ...(await original<typeof import("../../state/server")>()),
    primaryServerKeybindingsAtom: Atom.make([]),
  };
});
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../chat/PierreEntryIcon", () => ({ PierreEntryIcon: "pierre-icon" }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: "project-favicon" }));
vi.mock("./SeatSettingsPanel", () => ({
  useSeatCatalog: () => ({ entries: [], options: {} }),
}));
vi.mock("./SetupPanel", () => ({ SetupPanel: "setup-panel" }));
vi.mock("./TeamDefaultsDialog", () => ({ TeamDefaultsDialog: "team-defaults" }));
vi.mock("./TrackRecord", () => ({ TrackRecord: "track-record" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "tooltip-root",
  TooltipTrigger: (props: { render: ReactNode; children: ReactNode }) => props.render,
  TooltipPopup: "tooltip-popup",
}));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "scroll-area" }));
vi.mock("../ui/select", () => ({
  Select: "select-root",
  SelectTrigger: "select-trigger",
  SelectValue: "output",
  SelectPopup: "select-popup",
  SelectItem: "select-item",
}));
// Base UI's command dialog renders in a portal, which the test renderer cannot.
// These stand-ins keep its parts: the search box, the groups and their items.
vi.mock("../ui/command", async () => {
  const React = await import("react");
  type Props = Record<string, unknown> & { children?: ReactNode };
  const Search = React.createContext<{ value?: string; onValueChange?: (value: string) => void }>(
    {},
  );
  const Items = React.createContext<ReadonlyArray<unknown>>([]);
  const tag = (name: string) => (props: Props) => React.createElement(name, null, props.children);
  return {
    CommandDialog: (props: Props) =>
      props.open ? React.createElement("command-dialog", null, props.children) : null,
    CommandDialogPopup: (props: Props) =>
      React.createElement("command-popup", { "aria-label": props["aria-label"] }, props.children),
    Command: (props: Props) =>
      React.createElement(
        Search.Provider,
        {
          value: {
            value: props.value as string,
            onValueChange: props.onValueChange as (value: string) => void,
          },
        },
        React.createElement("command-root", { "aria-label": props["aria-label"] }, props.children),
      ),
    CommandInput: (props: Props) => {
      const search = React.useContext(Search);
      return React.createElement("input", {
        placeholder: props.placeholder,
        value: search.value,
        onChange: (event: { target: { value: string } }) =>
          search.onValueChange?.(event.target.value),
        onKeyDown: props.onKeyDown,
      });
    },
    CommandPanel: tag("command-panel"),
    CommandFooter: tag("command-footer"),
    CommandFooterAction: tag("button"),
    CommandList: tag("command-list"),
    CommandGroup: (props: Props) =>
      React.createElement(
        Items.Provider,
        { value: props.items as ReadonlyArray<unknown> },
        React.createElement("command-group", null, props.children),
      ),
    CommandGroupLabel: tag("command-group-label"),
    CommandCollection: (props: { children: (item: unknown) => ReactNode }) =>
      React.createElement(React.Fragment, null, React.useContext(Items).map(props.children)),
    CommandItem: (props: Props) =>
      React.createElement(
        "command-item",
        { value: props.value, onClick: props.onClick },
        props.children,
      ),
    CommandShortcut: tag("kbd"),
  };
});

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(() => {
    if (renderer) renderer.update(<ProfilePage />);
    else renderer = create(<ProfilePage />);
  });
}

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map(textOf).join("");
}

/** The stand-in command parts are custom tags, which the renderer's types do not name. */
function isTag(node: ReactTestInstance, tag: string): boolean {
  return (node.type as unknown) === tag;
}

function root() {
  if (!renderer) throw new Error("Not rendered.");
  return renderer.root;
}

/** The reference files the profile shows, in order. */
function shownReferences(): Array<string> {
  const heading = root().find((node) => node.type === "h3" && textOf(node) === "Reference files");
  return heading.parent!.findAllByType("li").map((item) => textOf(item).trim());
}

function button(label: string): ReactTestInstance {
  return root().find(
    (node) =>
      node.type === "button" &&
      (textOf(node).trim() === label || node.props["aria-label"] === label),
  );
}

function hasButton(label: string): boolean {
  return (
    root().findAll(
      (node) =>
        node.type === "button" &&
        (textOf(node).trim() === label || node.props["aria-label"] === label),
    ).length > 0
  );
}

function pickerOpen(): boolean {
  return root().findAll((node) => isTag(node, "command-dialog")).length > 0;
}

/** Picker rows whose title or description includes `label`, as listed. */
function rows(label: string): Array<ReactTestInstance> {
  return root().findAll((node) => isTag(node, "command-item") && textOf(node).includes(label));
}

function row(label: string): ReactTestInstance {
  const found = rows(label);
  if (found.length === 0) {
    const listed = root()
      .findAll((node) => isTag(node, "command-item"))
      .map((node) => textOf(node));
    throw new Error(`No row "${label}" in the picker. Listed: ${JSON.stringify(listed)}`);
  }
  return found[0]!;
}

async function click(node: ReactTestInstance) {
  await act(async () => {
    (node.props.onClick as () => void)();
  });
}

function searchBox(): ReactTestInstance {
  return root()
    .findAll((node) => isTag(node, "command-root"))[0]!
    .findByType("input");
}

async function search(text: string) {
  await act(async () => {
    (searchBox().props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: text },
    });
  });
}

async function pressInSearch(key: string) {
  await act(async () => {
    (searchBox().props.onKeyDown as (event: unknown) => void)({
      key,
      preventDefault: () => {},
      stopPropagation: () => {},
    });
  });
}

async function pickFromProject(project: string, file: string) {
  await click(button("Add from a project"));
  await click(row(project));
  await search(file.slice(file.lastIndexOf("/") + 1));
  await click(row(file));
}

/** Opens the folder browse and clicks each folder in turn, then the file. */
async function pickByBrowsing(folders: ReadonlyArray<string>, file: string) {
  await click(button("Browse files"));
  for (const folder of folders) await click(row(folder));
  await click(row(file));
}

function posixEnvironment(environment: string, home: string) {
  mock.os[environment] = "darwin";
  mock.browse[`${environment}|~/`] = {
    data: { parentPath: home, entries: [{ name: "notes", fullPath: `${home}/notes` }] },
    error: null,
    isPending: false,
  };
  mock.browse[`${environment}|${home}/`] = mock.browse[`${environment}|~/`]!;
  mock.browse[`${environment}|${home}/notes/`] = {
    data: { parentPath: `${home}/notes`, entries: [] },
    error: null,
    isPending: false,
  };
  mock.folderFiles[`${environment}|${home}`] = [{ path: "notes", kind: "directory" }];
  mock.folderFiles[`${environment}|${home}/notes`] = [
    { path: "plan.md", kind: "file" },
    { path: "drafts", kind: "directory" },
    { path: "build.log", kind: "file" },
  ];
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.environment = "env-a";
  mock.editable = true;
  mock.revision = 1;
  mock.references = [];
  mock.os = {};
  mock.baseDirectory = {};
  mock.browse = {};
  mock.folderFiles = {};
  posixEnvironment("env-a", "/home/me");
  posixEnvironment("env-b", "/home/other");
  mock.projects = [
    { id: "p1", environmentId: "env-a", title: "Site", workspaceRoot: "/home/me/site" },
    { id: "p1", environmentId: "env-b", title: "Elsewhere", workspaceRoot: "/home/me/site" },
  ];
  mock.projectFiles = {
    "env-a|/home/me/site": ["README.md", "docs/guide.md"],
    "env-b|/home/me/site": ["README.md", "docs/other.md"],
  };
  mock.action.mockReset().mockImplementation(async (path: string, body: unknown) => {
    if (path === "/api/profiles/mine") {
      mock.references = [...(body as { references: Array<string> }).references];
      mock.revision += 1;
      return { ok: true, body: { name: "mine", seats: [], note: "Saved." } };
    }
    return { ok: true, body: { loaded: ["mine"] } };
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("profile reference files", () => {
  it("has no field to type a path into", async () => {
    await render();
    const typed = root().findAll(
      (node) =>
        node.type === "input" &&
        /reference|path/i.test(`${node.props["aria-label"] ?? ""} ${node.props.placeholder ?? ""}`),
    );
    expect(typed).toEqual([]);
    expect(hasButton("Add from a project")).toBe(true);
    expect(hasButton("Browse files")).toBe(true);
  });

  it("adds a file found in a project of the engine's environment, by its full path", async () => {
    await render();
    await click(button("Add from a project"));
    // Only the projects of the engine's environment are offered.
    expect(rows("Site")).toHaveLength(1);
    expect(rows("Elsewhere")).toHaveLength(0);
    await click(row("Site"));
    await search("guide");
    expect(rows("README.md")).toHaveLength(0);
    await click(row("docs/guide.md"));
    expect(pickerOpen()).toBe(false);
    expect(shownReferences()).toEqual(["/home/me/site/docs/guide.md"]);
  });

  it("goes back from a project's files to the projects with Escape", async () => {
    await render();
    await click(button("Add from a project"));
    await click(row("Site"));
    await pressInSearch("Escape");
    expect(pickerOpen()).toBe(true);
    expect(rows("Site")).toHaveLength(1);
    expect(rows("README.md")).toHaveLength(0);
  });

  it("adds a file of a folder reached by browsing, outside any project", async () => {
    await render();
    await click(button("Browse files"));
    // Folders come from the browse, files from the folder's own listing, ignored ones too.
    await click(row("notes"));
    expect(rows("plan.md")).toHaveLength(1);
    expect(rows("build.log")).toHaveLength(1);
    expect(rows("drafts")).toHaveLength(0);
    await click(row("build.log"));
    expect(shownReferences()).toEqual(["/home/me/notes/build.log"]);
  });

  it("goes up a folder from the folder the server resolved", async () => {
    mock.browse["env-a|/home/"] = {
      data: { parentPath: "/home", entries: [{ name: "me", fullPath: "/home/me" }] },
      error: null,
      isPending: false,
    };
    mock.folderFiles["env-a|/home"] = [];
    await render();
    await click(button("Browse files"));
    await click(row(".."));
    expect(rows("me")).toHaveLength(1);
    await click(row("me"));
    await click(row("notes"));
    await click(row("plan.md"));
    expect(shownReferences()).toEqual(["/home/me/notes/plan.md"]);
  });

  it("says when a folder cannot be listed", async () => {
    mock.browse["env-a|~/"] = { data: null, error: "Permission denied.", isPending: false };
    await render();
    await click(button("Browse files"));
    expect(textOf(root().find((node) => isTag(node, "command-popup")))).toContain(
      "Permission denied.",
    );
  });

  it("does not list a file twice, whichever way it was added", async () => {
    mock.projects.push({
      id: "p2",
      environmentId: "env-a",
      title: "Home",
      workspaceRoot: "/home/me",
    });
    mock.projectFiles["env-a|/home/me"] = ["notes/plan.md"];
    await render();
    await pickByBrowsing(["notes"], "plan.md");
    await pickFromProject("Home", "notes/plan.md");
    await pickByBrowsing(["notes"], "plan.md");
    expect(shownReferences()).toEqual(["/home/me/notes/plan.md"]);
  });

  it("keeps both of two files picked at once", async () => {
    await render();
    await click(button("Add from a project"));
    await click(row("Site"));
    const readme = row("README.md");
    const guide = row("docs/guide.md");
    await act(async () => {
      (readme.props.onClick as () => void)();
      (guide.props.onClick as () => void)();
    });
    expect(shownReferences()).toEqual(["/home/me/site/README.md", "/home/me/site/docs/guide.md"]);
  });

  it("removes a reference with its remove button", async () => {
    mock.references = ["/home/me/a.md", "/home/me/b.md"];
    await render();
    await click(button("Remove /home/me/a.md"));
    expect(shownReferences()).toEqual(["/home/me/b.md"]);
  });

  it("offers no way to add or remove references on a locked profile", async () => {
    mock.editable = false;
    mock.references = ["/home/me/a.md"];
    await render();
    expect(shownReferences()).toEqual(["/home/me/a.md"]);
    expect(hasButton("Add from a project")).toBe(false);
    expect(hasButton("Browse files")).toBe(false);
    expect(hasButton("Remove /home/me/a.md")).toBe(false);
  });

  it("saves the full path and still lists it after Reload", async () => {
    await render();
    await pickByBrowsing(["notes"], "plan.md");
    await click(button("Save as revision 2"));
    expect(mock.action).toHaveBeenCalledWith(
      "/api/profiles/mine",
      expect.objectContaining({ references: ["/home/me/notes/plan.md"] }),
    );
    await render();
    await act(async () => {
      (
        root().find((node) => node.props["data-profile-reload"] === true).props
          .onClick as () => void
      )();
    });
    await render();
    expect(mock.action).toHaveBeenCalledWith("/api/profiles/reload", {});
    expect(shownReferences()).toEqual(["/home/me/notes/plan.md"]);
  });

  it("closes the picker when the engine's environment changes, and ignores its old rows", async () => {
    mock.browse["env-a|~/"] = { data: null, error: null, isPending: true };
    mock.browse["env-b|~/"] = { data: null, error: null, isPending: true };
    await render();
    await click(button("Add from a project"));
    await click(row("Site"));
    const oldPick = row("README.md").props.onClick as () => void;
    mock.environment = "env-b";
    await render();
    expect(pickerOpen()).toBe(false);
    await act(async () => oldPick());
    expect(shownReferences()).toEqual([]);

    // The old environment's browse answers late; the new one's picker lists its own.
    await click(button("Browse files"));
    mock.browse["env-a|~/"] = {
      data: { parentPath: "/home/me", entries: [{ name: "secret", fullPath: "/home/me/secret" }] },
      error: null,
      isPending: false,
    };
    await render();
    expect(rows("secret")).toHaveLength(0);
    mock.browse["env-b|~/"] = {
      data: {
        parentPath: "/home/other",
        entries: [{ name: "notes", fullPath: "/home/other/notes" }],
      },
      error: null,
      isPending: false,
    };
    await render();
    await click(row("notes"));
    await click(row("plan.md"));
    expect(shownReferences()).toEqual(["/home/other/notes/plan.md"]);
  });
});

describe("profile reference files on a Windows environment", () => {
  beforeEach(() => {
    mock.environment = "env-w";
    mock.os["env-w"] = "windows";
    mock.baseDirectory["env-w"] = "C:\\work";
    mock.browse["env-w|C:\\work\\"] = {
      data: { parentPath: "C:\\work", entries: [{ name: "docs", fullPath: "C:\\work\\docs" }] },
      error: null,
      isPending: false,
    };
    mock.browse["env-w|C:\\work\\docs\\"] = {
      data: { parentPath: "C:\\work\\docs", entries: [] },
      error: null,
      isPending: false,
    };
    mock.browse["env-w|C:\\"] = {
      data: { parentPath: "C:\\", entries: [{ name: "work", fullPath: "C:\\work" }] },
      error: null,
      isPending: false,
    };
    mock.folderFiles["env-w|C:\\"] = [];
    mock.folderFiles["env-w|C:\\work"] = [{ path: "docs", kind: "directory" }];
    mock.folderFiles["env-w|C:\\work\\docs"] = [{ path: "a.md", kind: "file" }];
    mock.projects = [
      { id: "w1", environmentId: "env-w", title: "Work", workspaceRoot: "C:/work" },
      { id: "w2", environmentId: "env-w", title: "Lower", workspaceRoot: "c:\\work" },
    ];
    mock.projectFiles = {
      "env-w|C:/work": ["docs/a.md"],
      "env-w|c:\\work": ["docs/a.md"],
    };
  });

  it("stores a file of a project at C:/work with backslashes only", async () => {
    await render();
    await pickFromProject("Work", "docs/a.md");
    expect(shownReferences()).toEqual(["C:\\work\\docs\\a.md"]);
  });

  it("browses the environment's Windows folders and adds a file", async () => {
    await render();
    await pickByBrowsing(["docs"], "a.md");
    expect(shownReferences()).toEqual(["C:\\work\\docs\\a.md"]);
  });

  it("does not go above the drive root", async () => {
    mock.baseDirectory["env-w"] = "C:\\";
    await render();
    await click(button("Browse files"));
    expect(rows("work")).toHaveLength(1);
    expect(rows("..")).toHaveLength(0);
  });

  it("keeps one entry for a project file and the same file browsed to", async () => {
    await render();
    await pickFromProject("Work", "docs/a.md");
    await pickByBrowsing(["docs"], "a.md");
    expect(shownReferences()).toEqual(["C:\\work\\docs\\a.md"]);
  });

  it("keeps one entry when the drive and folder case differ", async () => {
    await render();
    await pickFromProject("Lower", "docs/a.md");
    await pickByBrowsing(["docs"], "a.md");
    await pickFromProject("Work", "docs/a.md");
    expect(shownReferences()).toEqual(["c:\\work\\docs\\a.md"]);
  });

  it("keeps a reference stored with forward slashes and adds no second one", async () => {
    mock.references = ["C:/work/docs/a.md"];
    await render();
    await pickFromProject("Work", "docs/a.md");
    await pickByBrowsing(["docs"], "a.md");
    expect(shownReferences()).toEqual(["C:/work/docs/a.md"]);
  });
});
