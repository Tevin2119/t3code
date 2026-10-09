import { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseRepositories } from "../../lib/delivery";
import { BoardDialog, type PickerItem } from "./BoardPicker";
import {
  environmentBrowsePlatform,
  initialBrowseQuery,
  resolveBrowseFolder,
  suggestedRepositoryName,
} from "./BoardPicker.browse";
import {
  PROJECT_CHOICE_PREFIX,
  addedRepository,
  projectRepositoryName,
  repositoryChoices,
} from "./BoardPicker.repositories";

const mock = vi.hoisted(() => ({
  reading: {
    body: null as unknown,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  action: vi.fn(),
  projects: [] as Array<unknown>,
  // The board environment's presentation, by environment id.
  environments: {} as Record<string, unknown>,
  // Browse replies by environment id and partial path; a missing one is still being read.
  listings: {} as Record<string, { data?: unknown; error?: string }>,
  queried: [] as Array<{ environmentId: string; input: { partialPath: string; cwd?: string } }>,
  load: vi.fn(),
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: (id: string | null) => (id ? (mock.environments[id] ?? null) : null),
}));
vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: (target: unknown) => ({ browse: target }) },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { browse: (typeof mock.queried)[number] } | null) => {
    if (!atom) return { data: null, error: null, isPending: false, isSuccess: false };
    mock.queried.push(atom.browse);
    const reply = mock.listings[`${atom.browse.environmentId}:${atom.browse.input.partialPath}`];
    return {
      data: reply?.data ?? null,
      error: reply?.error ?? null,
      isPending: !reply,
      isSuccess: Boolean(reply?.data),
    };
  },
}));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mock.load }));
vi.mock("../CommandPaletteContent", () => ({ CommandPaletteContent: "palette-content" }));
vi.mock("../CommandPaletteResults", () => ({ CommandPaletteResults: "palette-results" }));
vi.mock("../../state/delivery", async (original) => ({
  ...(await original<typeof import("../../state/delivery")>()),
  useDeliveryRead: () => mock.reading,
  useDeliveryAct: () => mock.action,
}));
vi.mock("../../state/entities", () => ({ useProjects: () => mock.projects }));
vi.mock("../ui/select", () => ({
  Select: "select-root",
  SelectTrigger: "select-trigger",
  SelectValue: "output",
  SelectPopup: "select-popup",
  SelectItem: "select-item",
  SelectGroup: "select-group",
  SelectGroupLabel: "select-group-label",
  selectTriggerVariants: () => "",
}));
vi.mock("../ui/dialog", () => ({
  Dialog: "dialog-root",
  DialogDescription: "dialog-description",
  DialogFooter: "dialog-footer",
  DialogHeader: "dialog-header",
  DialogPanel: "dialog-panel",
  DialogPopup: "dialog-popup",
  DialogTitle: "dialog-title",
}));
vi.mock("../ui/popover", () => ({
  Popover: "popover-root",
  PopoverTrigger: "popover-trigger",
  PopoverPopup: "popover-popup",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "checkbox" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "tooltip-root",
  TooltipTrigger: "tooltip-trigger",
  TooltipPopup: "tooltip-popup",
}));

const ENV = EnvironmentId.make("env-a");
const OTHER = EnvironmentId.make("env-b");

const project = (
  id: string,
  workspaceRoot: string,
  extra: Partial<{
    environmentId: EnvironmentId;
    title: string;
    repositoryIdentity: { displayName?: string; name?: string } | null;
  }> = {},
) =>
  ({
    id,
    environmentId: extra.environmentId ?? ENV,
    title: extra.title ?? id,
    workspaceRoot,
    repositoryIdentity: extra.repositoryIdentity ?? null,
  }) as unknown as EnvironmentProject;

const engineRepo = (id: string, path: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  path,
  defaultBase: "main",
  branches: ["main", "dev"],
  kind: "own",
  ok: true,
  problem: null,
  ...extra,
});

describe("repositoryChoices", () => {
  const choose = (
    body: unknown,
    projects: ReadonlyArray<EnvironmentProject>,
    environmentId: EnvironmentId | null = ENV,
  ) => repositoryChoices({ repositories: parseRepositories(body), projects, environmentId });

  it("offers only the board environment's projects, and none without an environment", () => {
    const projects = [project("p1", "/work/a"), project("p2", "/work/b", { environmentId: OTHER })];
    expect(choose([], projects).map((choice) => choice.value)).toEqual([
      `${PROJECT_CHOICE_PREFIX}p1`,
    ]);
    expect(choose([], projects, null)).toEqual([]);
  });

  it("names a project by its repository's display name, then name, then title", () => {
    expect(
      projectRepositoryName(
        project("p", "/a", { title: "t", repositoryIdentity: { displayName: "d", name: "n" } }),
      ),
    ).toBe("d");
    expect(
      projectRepositoryName(project("p", "/a", { title: "t", repositoryIdentity: { name: "n" } })),
    ).toBe("n");
    expect(projectRepositoryName(project("p", "/a", { title: "t" }))).toBe("t");
  });

  it("lists engine-only and project-only entries each with a name and a folder", () => {
    const choices = choose(
      [engineRepo("r1", "/work/engine")],
      [project("p1", "/work/proj", { title: "Proj" })],
    );
    expect(
      choices.map((choice) =>
        choice.kind === "engine"
          ? [choice.repository.title, choice.repository.path]
          : [choice.name, choice.folder],
      ),
    ).toEqual([
      ["r1", "/work/engine"],
      ["Proj", "/work/proj"],
    ]);
  });

  it("folds a project into the engine repository in the same folder, after a trailing slash", () => {
    const choices = choose([engineRepo("r1", "/work/a")], [project("p1", "/work/a/")]);
    expect(choices.map((choice) => choice.value)).toEqual(["r1"]);
  });

  it("matches Windows folders whatever their case, and keeps POSIX case distinct", () => {
    expect(
      choose([engineRepo("r1", "C:\\Work\\A")], [project("p1", "c:\\work\\a")]).map(
        (choice) => choice.value,
      ),
    ).toEqual(["r1"]);
    expect(
      choose([engineRepo("r1", "/Work/A")], [project("p1", "/work/a")]).map(
        (choice) => choice.value,
      ),
    ).toEqual(["r1", `${PROJECT_CHOICE_PREFIX}p1`]);
  });

  it("keeps distinct folders apart even with the same name", () => {
    const choices = choose(
      [],
      [
        project("p1", "/work/a", { repositoryIdentity: { name: "same" } }),
        project("p2", "/other/a", { repositoryIdentity: { name: "same" } }),
      ],
    );
    expect(choices).toHaveLength(2);
  });

  it("hides a qualification repository and never offers its folder for adding", () => {
    const choices = choose(
      [engineRepo("q1", "/work/q", { kind: "qualification" })],
      [project("p1", "/work/q")],
    );
    expect(choices).toEqual([]);
  });

  it("keeps an unavailable match as the engine's row with its problem", () => {
    const choices = choose(
      [engineRepo("r1", "/work/a", { ok: false, problem: "missing" })],
      [project("p1", "/work/a")],
    );
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({
      kind: "engine",
      repository: { ok: false, problem: "missing" },
    });
  });
});

describe("addedRepository", () => {
  const submitted = { path: "/work/a", title: "A" };
  it("refuses a reply that names no repository", () => {
    expect(addedRepository({ id: 7 }, submitted)).toBeNull();
    expect(addedRepository({}, submitted)).toBeNull();
    expect(addedRepository({ id: "" }, submitted)).toBeNull();
    expect(addedRepository(null, submitted)).toBeNull();
  });
  it("fills what the reply leaves out from what was sent", () => {
    expect(addedRepository({ id: "r9", defaultBase: "main" }, submitted)).toMatchObject({
      id: "r9",
      title: "A",
      path: "/work/a",
      defaultBase: "main",
      branches: ["main"],
      ok: true,
    });
    expect(addedRepository({ id: "r9", defaultBase: 3 }, submitted)?.defaultBase).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("BoardDialog repository list", () => {
  let renderer: ReactTestRenderer | undefined;
  const saved = vi.fn();
  const view = (editing: PickerItem | null = null) => (
    <BoardDialog
      kind="board"
      editing={editing}
      environmentId={ENV}
      by="person"
      busy={false}
      problem={null}
      onClose={() => undefined}
      onSave={saved}
    />
  );
  async function render(editing: PickerItem | null = null) {
    await act(() => {
      if (renderer) renderer.update(view(editing));
      else renderer = create(view(editing));
    });
  }
  const selects = () => renderer!.root.findAllByType("select-root" as never);
  const repositorySelect = () => selects()[0]!;
  const baseSelect = () => selects()[1]!;
  const shown = (node: ReactTestInstance) => {
    const value = node.findByType("output" as never);
    return value.children.join("");
  };
  async function choose(value: string) {
    await act(async () => {
      repositorySelect().props.onValueChange(value);
    });
  }
  const saveButton = () => renderer!.root.findByProps({ "data-board-dialog-save": true });
  const problem = () =>
    renderer!.root.findByProps({ "data-board-dialog-repository-problem": true }).children.join("");
  const items = () =>
    renderer!.root
      .findAllByType("select-item" as never)
      .filter((item) => item.props.value !== "__add_repository__");
  const text = (node: ReactTestInstance): string =>
    node.children.map((child) => (typeof child === "string" ? child : text(child))).join("|");

  beforeEach(() => {
    mock.reading = { body: [], error: null, isPending: false, refresh: vi.fn() };
    mock.action = vi.fn();
    mock.projects = [];
    mock.environments = {};
    mock.listings = {};
    saved.mockReset();
  });
  afterEach(async () => {
    await act(() => renderer?.unmount());
    renderer = undefined;
  });

  it("shows T3 projects and engine repositories, each with a name and a folder", async () => {
    mock.reading.body = [
      engineRepo("r1", "/work/engine", { title: "Engine" }),
      engineRepo("r2", "/work/broken", { ok: false, problem: "Folder is gone" }),
    ];
    mock.projects = [project("p1", "/work/proj", { title: "Proj" })];
    await render();
    expect(items().map(text)).toEqual([
      "Engine|/work/engine",
      "r2|/work/broken|Folder is gone",
      "Proj|/work/proj",
    ]);
  });

  it("adds an unmatched project with its folder and name, and selects it before the list is read again", async () => {
    mock.projects = [
      project("p1", "/work/proj", { title: "proj", repositoryIdentity: { displayName: "Proj" } }),
    ];
    const reply = deferred<unknown>();
    mock.action.mockReturnValue(reply.promise);
    await render();
    await choose(`${PROJECT_CHOICE_PREFIX}p1`);
    expect(mock.action).toHaveBeenCalledTimes(1);
    expect(mock.action).toHaveBeenCalledWith("/api/repositories", {
      path: "/work/proj",
      title: "Proj",
      by: "person",
    });
    // While pending nothing else can be chosen, and the choice is said.
    expect(repositorySelect().props.disabled).toBe(true);
    expect(saveButton().props.disabled).toBe(true);
    expect(shown(repositorySelect())).toBe("Proj");
    await choose(`${PROJECT_CHOICE_PREFIX}p1`);
    expect(mock.action).toHaveBeenCalledTimes(1);

    await act(async () => reply.resolve({ ok: true, body: { id: "r9", defaultBase: "trunk" } }));
    expect(mock.reading.refresh).toHaveBeenCalled();
    expect(repositorySelect().props.value).toBe("r9");
    expect(shown(repositorySelect())).toBe("Proj");
    expect(baseSelect().props.value).toBe("trunk");
    expect(baseSelect().props.disabled).toBe(false);
    expect(saveButton().props.disabled).toBe(false);
    await act(() => saveButton().props.onClick());
    expect(saved).toHaveBeenCalledWith({
      title: "Proj",
      description: "",
      repository: "r9",
      base: "trunk",
    });

    // Chosen again before the engine's list is read again: the added repository, not a new add.
    await choose(`${PROJECT_CHOICE_PREFIX}p1`);
    expect(mock.action).toHaveBeenCalledTimes(1);
    expect(repositorySelect().props.value).toBe("r9");
  });

  it("selects the engine repository in the project's folder and adds nothing", async () => {
    mock.reading.body = [engineRepo("r1", "/work/a", { defaultBase: "develop" })];
    mock.projects = [project("p1", "/work/a/")];
    await render();
    expect(items().map((item) => item.props.value)).toEqual(["r1"]);
    await choose("r1");
    expect(mock.action).not.toHaveBeenCalled();
    expect(repositorySelect().props.value).toBe("r1");
    expect(baseSelect().props.value).toBe("develop");
  });

  it("shows the engine's reason when the add fails, selects nothing, and lets it be tried again", async () => {
    mock.reading.body = [engineRepo("r1", "/work/a")];
    mock.projects = [project("p1", "/work/b", { title: "B" })];
    mock.action.mockResolvedValueOnce({ ok: false, why: "Not a git repository", problems: [] });
    await render();
    await choose("r1");
    await choose(`${PROJECT_CHOICE_PREFIX}p1`);
    expect(problem()).toBe("Not a git repository");
    expect(repositorySelect().props.value).toBeNull();
    expect(baseSelect().props.value).toBeNull();
    expect(saveButton().props.disabled).toBe(true);

    mock.action.mockResolvedValueOnce({ ok: true, body: { id: "r2", defaultBase: "main" } });
    await choose(`${PROJECT_CHOICE_PREFIX}p1`);
    expect(problem()).toBe("");
    expect(mock.action).toHaveBeenCalledTimes(2);
    expect(repositorySelect().props.value).toBe("r2");
  });

  it.each([[{ id: 7 }], [{}], [{ id: "" }]])(
    "selects nothing and says why when the reply names no repository: %j",
    async (body) => {
      mock.projects = [project("p1", "/work/b", { title: "B" })];
      mock.action.mockResolvedValueOnce({ ok: true, body });
      await render();
      await choose(`${PROJECT_CHOICE_PREFIX}p1`);
      expect(repositorySelect().props.value).toBeNull();
      expect(problem()).toContain("did not say which repository");
      expect(saveButton().props.disabled).toBe(true);
    },
  );

  it("leaves the base empty when the reply has no default base", async () => {
    mock.projects = [project("p1", "/work/b", { title: "B" })];
    mock.action.mockResolvedValueOnce({ ok: true, body: { id: "r2" } });
    await render();
    await choose(`${PROJECT_CHOICE_PREFIX}p1`);
    expect(repositorySelect().props.value).toBe("r2");
    expect(baseSelect().props.value).toBeNull();
    expect(saveButton().props.disabled).toBe(true);
  });

  it.each([
    ["still being read", { body: null, error: null, isPending: true }],
    ["unreadable", { body: null, error: "engine down", isPending: false }],
  ])("adds nothing while the engine's list is %s", async (_, reading) => {
    mock.reading = { ...reading, refresh: vi.fn() };
    mock.projects = [project("p1", "/work/b")];
    await render();
    expect(items()[0]!.props.disabled).toBe(true);
    await choose(`${PROJECT_CHOICE_PREFIX}p1`);
    expect(mock.action).not.toHaveBeenCalled();
    expect(problem()).not.toBe("");
  });

  it("ignores an add that ends after the dialog closed", async () => {
    mock.projects = [project("p1", "/work/b")];
    const reply = deferred<unknown>();
    mock.action.mockReturnValue(reply.promise);
    await render();
    await choose(`${PROJECT_CHOICE_PREFIX}p1`);
    await act(() => renderer!.unmount());
    renderer = undefined;
    await act(async () => reply.resolve({ ok: true, body: { id: "r2", defaultBase: "main" } }));
    expect(mock.reading.refresh).not.toHaveBeenCalled();
  });

  it("leaves an unchanged binding out of what an edited board saves", async () => {
    mock.reading.body = [engineRepo("r1", "/work/a")];
    await render({
      id: "b1",
      title: "Board",
      description: "",
      kind: "own",
      target: {
        ok: true,
        repository: "r1",
        base: "main",
        title: "r1",
        path: "/work/a",
        problem: null,
      },
    });
    await act(() => saveButton().props.onClick());
    expect(saved).toHaveBeenCalledWith({ title: "Board", description: "" });
  });
});

const entriesOf = (parentPath: string, names: ReadonlyArray<string>) => {
  const separator = parentPath.includes("\\") ? "\\" : "/";
  return names.map((name) => ({
    name,
    fullPath: `${parentPath.replace(/[\\/]$/, "")}${separator}${name}`,
  }));
};
const listing = (parentPath: string, names: ReadonlyArray<string>) => ({
  parentPath,
  entries: entriesOf(parentPath, names),
});

describe("resolveBrowseFolder", () => {
  const resolve = (
    query: string,
    data: ReturnType<typeof listing> | null,
    extra: Partial<Parameters<typeof resolveBrowseFolder>[0]> = {},
  ) =>
    resolveBrowseFolder({
      query,
      platform: "MacIntel",
      connected: true,
      moving: false,
      data,
      error: null,
      isPending: false,
      ...extra,
    });

  it("takes a folder query's server-resolved path, after home is expanded", () => {
    expect(resolve("~/work/", listing("/home/u/work", ["a"])).path).toBe("/home/u/work");
    expect(resolve("~/", listing("/home/u", ["work"])).path).toBe("/home/u");
    expect(resolve("/", listing("/", ["home"])).path).toBe("/");
  });

  it("takes the exact entry's full path for a leaf, with spaces or a leading dot", () => {
    const home = listing("/home/u", ["my repo", ".config", "work", "workshop"]);
    expect(resolve("~/my repo", home).path).toBe("/home/u/my repo");
    expect(resolve("~/.config", home).path).toBe("/home/u/.config");
    expect(resolve("~/work", home).path).toBe("/home/u/work");
  });

  it("resolves Windows roots and folders only on a Windows environment", () => {
    const drive = listing("C:\\", ["Users"]);
    expect(resolve("C:\\", drive, { platform: "Win32" }).path).toBe("C:\\");
    expect(resolve("C:\\Users", drive, { platform: "Win32" }).path).toBe("C:\\Users");
    expect(resolve("C:\\Users", drive).why).toBe("Use an absolute or ~/ path.");
  });

  it("never falls back to the typed text", () => {
    const home = listing("/home/u", ["work"]);
    expect(resolve("", home)).toEqual({ path: null, why: "Choose a folder." });
    expect(resolve("~/wo", home)).toEqual({ path: null, why: "Choose a folder." });
    expect(resolve("./x/", home).why).toBe("Use an absolute or ~/ path.");
    expect(resolve("work/x", home).why).toBe("Use an absolute or ~/ path.");
    expect(resolve("~/work/", null, { isPending: true }).why).toBe("Reading…");
    expect(resolve("~/work/", null, { error: "No such folder" }).why).toBe("No such folder");
    expect(resolve("~/work/", home, { connected: false }).why).toBe("Not connected.");
    expect(resolve("~/", home, { moving: true }).why).toBe("Opening folder…");
  });
});

describe("suggestedRepositoryName", () => {
  it("names a known T3 project by its repository, and any other folder by its own name", () => {
    const projects = [
      project("p1", "/home/u/proj", { repositoryIdentity: { displayName: "Proj" } }),
      project("p2", "/home/u/elsewhere", { environmentId: OTHER, title: "Other" }),
    ];
    expect(suggestedRepositoryName("/home/u/proj/", projects, ENV)).toBe("Proj");
    expect(suggestedRepositoryName("/home/u/elsewhere", projects, ENV)).toBe("elsewhere");
    expect(suggestedRepositoryName("/home/u/plain", projects, ENV)).toBe("plain");
  });
  it("matches a Windows project whatever its case", () => {
    const projects = [project("p1", "C:\\Work\\Repo", { repositoryIdentity: { name: "repo-x" } })];
    expect(suggestedRepositoryName("c:\\work\\repo", projects, ENV)).toBe("repo-x");
  });
});

describe("browse settings", () => {
  it("starts at home, or at the environment's add-project folder", () => {
    expect(initialBrowseQuery(undefined)).toBe("~/");
    expect(initialBrowseQuery("  ")).toBe("~/");
    expect(initialBrowseQuery("/srv/code")).toBe("/srv/code/");
    expect(initialBrowseQuery("C:\\code")).toBe("C:\\code\\");
  });
  it("maps the environment's os to a browse platform", () => {
    expect(environmentBrowsePlatform("windows")).toBe("Win32");
    expect(environmentBrowsePlatform("darwin")).toBe("MacIntel");
  });
});

describe("BoardDialog adds a repository by browsing", () => {
  let renderer: ReactTestRenderer | undefined;
  const environment = (
    extra: Partial<{ os: string; base: string; phase: string }> = {},
  ): unknown => ({
    serverConfig: {
      settings: { addProjectBaseDirectory: extra.base ?? "" },
      environment: { platform: { os: extra.os ?? "darwin" } },
    },
    connection: { phase: extra.phase ?? "connected" },
  });
  const view = (environmentId: EnvironmentId) => (
    <BoardDialog
      kind="board"
      editing={null}
      environmentId={environmentId}
      by="person"
      busy={false}
      problem={null}
      onClose={() => undefined}
      onSave={() => undefined}
    />
  );
  async function render(environmentId: EnvironmentId = ENV) {
    await act(() => {
      if (renderer) renderer.update(view(environmentId));
      else renderer = create(view(environmentId));
    });
  }
  const find = (prop: string) => renderer!.root.findByProps({ [prop]: true });
  const repositorySelect = () => renderer!.root.findAllByType("select-root" as never)[0]!;
  const baseSelect = () => renderer!.root.findAllByType("select-root" as never)[1]!;
  async function openAdd() {
    await act(async () => repositorySelect().props.onValueChange("__add_repository__"));
  }
  const palette = () => renderer!.root.findByType("palette-content" as never);
  const results = () => renderer!.root.findByType("palette-results" as never);
  const rows = (): Array<{ value: string; title: string; run: () => Promise<void> }> =>
    results().props.groups.flatMap((group: { items: Array<unknown> }) => group.items);
  const rowValues = () => rows().map((row) => row.value);
  async function type(value: string) {
    await act(async () => palette().props.onValueChange(value));
  }
  async function run(value: string) {
    await act(async () => {
      await rows()
        .find((row) => row.value === value)!
        .run();
    });
  }
  const folderShown = () => renderer!.root.findByType("tooltip-trigger" as never).children.join("");
  const nameInput = () => find("data-board-dialog-repository-name");
  const addButton = () => find("data-board-dialog-add-repository");
  const why = () => renderer!.root.findAllByProps({ "data-board-dialog-add-why": true })[0];
  const status = () =>
    renderer!.root
      .findAllByProps({ "data-board-dialog-browse-status": true })
      .map((node) => node.children.join(""))[0];
  const resultsShown = () => renderer!.root.findAllByType("palette-results" as never).length > 0;
  const paths = () => mock.queried.map((item) => `${item.environmentId}:${item.input.partialPath}`);

  beforeEach(() => {
    mock.reading = { body: [], error: null, isPending: false, refresh: vi.fn() };
    mock.action = vi.fn();
    mock.projects = [];
    mock.environments = { [ENV]: environment() };
    mock.listings = {
      [`${ENV}:~/`]: { data: listing("/home/u", ["work", "proj", ".hidden"]) },
      [`${ENV}:~/work/`]: { data: listing("/home/u/work", ["typed", "other"]) },
      [`${ENV}:~/work/typed/`]: { data: listing("/home/u/work/typed", []) },
      [`${ENV}:~/work/other/`]: { data: listing("/home/u/work/other", []) },
      [`${ENV}:~/proj/`]: { data: listing("/home/u/proj", []) },
      [`${ENV}:/Users/x/`]: { data: listing("/Users/x", ["code"]) },
      [`${ENV}:/`]: { data: listing("/", ["Users"]) },
    };
    mock.queried = [];
    mock.load = vi.fn().mockResolvedValue({ _tag: "Success" });
  });
  afterEach(async () => {
    await act(() => renderer?.unmount());
    renderer = undefined;
  });

  it("starts at home, lists its folders without hidden ones, and offers no Up there", async () => {
    await render();
    await openAdd();
    expect(palette().props.value).toBe("~/");
    expect(mock.queried.at(-1)).toEqual({ environmentId: ENV, input: { partialPath: "~/" } });
    expect(rows().map((row) => row.title)).toEqual(["work", "proj"]);
  });

  it("starts at the environment's add-project folder when it has one", async () => {
    mock.environments = { [ENV]: environment({ base: "/Users/x" }) };
    await render();
    await openAdd();
    expect(palette().props.value).toBe("/Users/x/");
    expect(rowValues()).toEqual(["browse:up", "browse:/Users/x/code"]);
  });

  it("filters as a path is typed, and resolves only an exact folder", async () => {
    await render();
    await openAdd();
    await type("~/wo");
    expect(rows().map((row) => row.title)).toEqual(["work"]);
    expect(addButton().props.disabled).toBe(true);
    expect(why()!.children.join("")).toBe("Choose a folder.");
    await type("~/work");
    expect(folderShown()).toBe("Folder: /home/u/work");
    expect(nameInput().props.value).toBe("work");
    expect(addButton().props.disabled).toBe(false);
  });

  it("goes up to the parent, and offers no Up at the root", async () => {
    mock.environments = { [ENV]: environment({ base: "/Users/x" }) };
    await render();
    await openAdd();
    await run("browse:up");
    expect(mock.load).toHaveBeenLastCalledWith({
      environmentId: ENV,
      input: { partialPath: "/Users/" },
    });
    expect(palette().props.value).toBe("/Users/");
    await type("/");
    expect(rowValues()).toEqual(["browse:/Users"]);
  });

  it("moves into a picked folder after its listing loads", async () => {
    await render();
    await openAdd();
    await run("browse:/home/u/work");
    expect(mock.load).toHaveBeenLastCalledWith({
      environmentId: ENV,
      input: { partialPath: "~/work/" },
    });
    expect(palette().props.value).toBe("~/work/");
    expect(rows().map((row) => row.title)).toEqual(["..", "typed", "other"]);
    expect(folderShown()).toBe("Folder: /home/u/work");
  });

  it("adds nothing while a picked folder is still opening", async () => {
    mock.action.mockResolvedValueOnce({ ok: true, body: { id: "r8", defaultBase: "main" } });
    await render();
    await openAdd();
    const slow = deferred<unknown>();
    mock.load.mockReturnValueOnce(slow.promise);
    let move: Promise<void> = Promise.resolve();
    await act(async () => {
      move = rows()[0]!.run();
    });
    expect(palette().props.value).toBe("~/");
    expect(addButton().props.disabled).toBe(true);
    expect(why()!.children.join("")).toBe("Opening folder…");
    await act(async () => addButton().props.onClick());
    expect(mock.action).not.toHaveBeenCalled();
    await act(async () => {
      slow.resolve({});
      await move;
    });
    expect(palette().props.value).toBe("~/work/");
    await act(async () => addButton().props.onClick());
    expect(mock.action).toHaveBeenCalledWith("/api/repositories", {
      path: "/home/u/work",
      title: "work",
      by: "person",
    });
  });

  it("stays opening until the latest of two moves lands, and typing ends it", async () => {
    await render();
    await openAdd();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mock.load.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let moves: Array<Promise<void>> = [];
    await act(async () => {
      moves = [rows()[0]!.run(), rows()[1]!.run()];
    });
    await act(async () => {
      first.resolve({});
      await moves[0];
    });
    expect(why()!.children.join("")).toBe("Opening folder…");
    await act(async () => {
      second.resolve({});
      await moves[1];
    });
    expect(palette().props.value).toBe("~/proj/");
    expect(addButton().props.disabled).toBe(false);

    const late = deferred<unknown>();
    mock.load.mockReturnValueOnce(late.promise);
    let move: Promise<void> = Promise.resolve();
    await act(async () => {
      move = rows()[0]!.run();
    });
    expect(addButton().props.disabled).toBe(true);
    await type("~/work/");
    expect(addButton().props.disabled).toBe(false);
    await act(async () => {
      late.resolve({});
      await move;
    });
    expect(palette().props.value).toBe("~/work/");
    expect(addButton().props.disabled).toBe(false);
  });

  it("says why the list is empty, also when only Up is left", async () => {
    mock.listings[`${ENV}:~/broken/`] = { error: "No such folder" };
    await render();
    await openAdd();
    expect(status()).toBeUndefined();
    await type("~/work/typed/");
    expect(rowValues()).toEqual(["browse:up"]);
    expect(status()).toBe("No folders here.");
    await type("~/work/zz");
    expect(rowValues()).toEqual(["browse:up"]);
    expect(status()).toBe("No folders here.");
    await type("~/unread/");
    expect(status()).toBe("Reading folders…");
    await type("~/broken/");
    expect(status()).toBe("No such folder");
    await type("./x/");
    expect(resultsShown()).toBe(false);
    expect(status()).toBe("Use an absolute or ~/ path.");
    mock.listings[`${ENV}:/`] = { data: listing("/", []) };
    await type("/");
    expect(resultsShown()).toBe(false);
    expect(status()).toBe("No folders here.");
  });

  it("keeps only the latest move, and typing beats a move still loading", async () => {
    await render();
    await openAdd();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mock.load.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let moves: Array<Promise<void>> = [];
    await act(async () => {
      moves = [rows()[0]!.run(), rows()[1]!.run()];
    });
    await act(async () => {
      second.resolve({});
      first.resolve({});
      await Promise.all(moves);
    });
    expect(palette().props.value).toBe("~/proj/");

    const late = deferred<unknown>();
    mock.load.mockReturnValueOnce(late.promise);
    await type("~/");
    let move: Promise<void> = Promise.resolve();
    await act(async () => {
      move = rows()[0]!.run();
    });
    await type("~/wo");
    await act(async () => {
      late.resolve({});
      await move;
    });
    expect(palette().props.value).toBe("~/wo");
  });

  it("posts the server-resolved path and suggested name, and selects the repository", async () => {
    mock.action.mockResolvedValueOnce({ ok: true, body: { id: "r5", defaultBase: "main" } });
    await render();
    await openAdd();
    await type("~/work/typed/");
    expect(nameInput().props.value).toBe("typed");
    await act(async () => addButton().props.onClick());
    expect(mock.action).toHaveBeenCalledWith("/api/repositories", {
      path: "/home/u/work/typed",
      title: "typed",
      by: "person",
    });
    expect(repositorySelect().props.value).toBe("r5");
    expect(baseSelect().props.value).toBe("main");
    expect(renderer!.root.findAllByType("palette-content" as never)).toHaveLength(0);
  });

  it("names a known T3 project by its repository, matched after home is expanded", async () => {
    mock.projects = [
      project("p1", "/home/u/proj", { title: "proj", repositoryIdentity: { displayName: "Proj" } }),
    ];
    await render();
    await openAdd();
    await type("~/proj/");
    expect(nameInput().props.value).toBe("Proj");
  });

  it("keeps an edited name for its folder, replaces it for another, and blocks a blank one", async () => {
    mock.action.mockResolvedValueOnce({ ok: true, body: { id: "r6", defaultBase: "main" } });
    await render();
    await openAdd();
    await type("~/work/typed/");
    await act(() => nameInput().props.onChange({ target: { value: "My repo" } }));
    await render();
    expect(nameInput().props.value).toBe("My repo");
    await type("~/work/other/");
    expect(nameInput().props.value).toBe("other");
    await act(() => nameInput().props.onChange({ target: { value: "  " } }));
    expect(addButton().props.disabled).toBe(true);
    expect(why()!.children.join("")).toBe("Name is empty.");
    await act(async () => addButton().props.onClick());
    expect(mock.action).not.toHaveBeenCalled();
    await act(() => nameInput().props.onChange({ target: { value: " Other one " } }));
    await act(async () => addButton().props.onClick());
    expect(mock.action).toHaveBeenCalledWith("/api/repositories", {
      path: "/home/u/work/other",
      title: "Other one",
      by: "person",
    });
  });

  it("drops an edited name once another folder is chosen, so coming back suggests again", async () => {
    await render();
    await openAdd();
    await type("~/work/typed/");
    await act(() => nameInput().props.onChange({ target: { value: "My repo" } }));
    await type("~/work/typed");
    expect(nameInput().props.value).toBe("My repo");
    await type("~/work/other/");
    expect(nameInput().props.value).toBe("other");
    await type("~/work/typed/");
    expect(nameInput().props.value).toBe("typed");
  });

  it.each([
    ["a relative path", "./x/", "Use an absolute or ~/ path."],
    ["an empty path", "", "Choose a folder."],
    ["a folder still being read", "~/unread/", "Reading…"],
    ["a folder that cannot be read", "~/broken/", "No such folder"],
  ])("adds nothing for %s", async (_, query, reason) => {
    mock.listings[`${ENV}:~/broken/`] = { error: "No such folder" };
    await render();
    await openAdd();
    await type(query);
    expect(addButton().props.disabled).toBe(true);
    expect(why()!.children.join("")).toBe(reason);
    await act(async () => addButton().props.onClick());
    expect(mock.action).not.toHaveBeenCalled();
    expect(paths()).not.toContain(`${ENV}:./x/`);
  });

  it("adds nothing while the environment is not connected", async () => {
    mock.environments = { [ENV]: environment({ phase: "disconnected" }) };
    await render();
    await openAdd();
    await type("~/work/");
    expect(why()!.children.join("")).toBe("Not connected.");
    await act(async () => addButton().props.onClick());
    expect(mock.action).not.toHaveBeenCalled();
  });

  it("browses Windows paths only on a Windows environment", async () => {
    mock.environments = { [ENV]: environment({ os: "windows" }) };
    await render();
    await openAdd();
    await type("C:/Users/");
    expect(paths().at(-1)).toBe(`${ENV}:C:/Users/`);
    await act(() => renderer!.unmount());
    renderer = undefined;
    mock.queried = [];
    mock.environments = { [ENV]: environment({ os: "darwin" }) };
    await render();
    await openAdd();
    await type("C:/Users/");
    expect(paths()).not.toContain(`${ENV}:C:/Users/`);
  });

  it("never adds the previous environment's folder after the environment changes", async () => {
    mock.environments = { [ENV]: environment(), [OTHER]: environment() };
    await render();
    await openAdd();
    await type("~/work/typed/");
    expect(addButton().props.disabled).toBe(false);
    await render(OTHER);
    if (renderer!.root.findAllByType("palette-content" as never).length === 0) await openAdd();
    expect(palette().props.value).toBe("~/");
    expect(paths().at(-1)).toBe(`${OTHER}:~/`);
    expect(addButton().props.disabled).toBe(true);
    await act(async () => addButton().props.onClick());
    expect(mock.action).not.toHaveBeenCalled();
  });

  it("lets go of an add cancelled while it runs, and leaves the reopened form alone", async () => {
    const reply = deferred<unknown>();
    mock.action.mockReturnValue(reply.promise);
    await render();
    await openAdd();
    await type("~/work/typed/");
    await act(async () => addButton().props.onClick());
    expect(repositorySelect().props.disabled).toBe(true);
    await act(async () => find("data-board-dialog-add-cancel").props.onClick());
    expect(repositorySelect().props.disabled).toBe(false);
    await openAdd();
    expect(palette().props.value).toBe("~/");
    await act(async () => reply.resolve({ ok: true, body: { id: "r7", defaultBase: "main" } }));
    expect(mock.reading.refresh).not.toHaveBeenCalled();
    expect(repositorySelect().props.value).toBeNull();
    expect(repositorySelect().props.disabled).toBe(false);
    expect(palette().props.value).toBe("~/");
    expect(addButton().props.disabled).toBe(false);
    expect(folderShown()).toBe("Folder: /home/u");
  });

  it("cancels the add on Escape without the key reaching the board dialog", async () => {
    await render();
    await openAdd();
    const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await act(async () => palette().props.inputProps.onKeyDown(event));
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(renderer!.root.findAllByType("palette-content" as never)).toHaveLength(0);
  });
});
