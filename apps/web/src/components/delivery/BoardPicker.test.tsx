import { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseRepositories } from "../../lib/delivery";
import { BoardDialog, type PickerItem } from "./BoardPicker";
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
}));
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

  it("still adds a repository by its folder", async () => {
    mock.action.mockResolvedValueOnce({ ok: true, body: { id: "r5", defaultBase: "main" } });
    await render();
    await choose("__add_repository__");
    const folder = renderer!.root.findByProps({ "data-board-dialog-folder": true });
    await act(() => folder.props.onChange({ target: { value: "/work/typed/" } }));
    await act(async () =>
      renderer!.root.findByProps({ "data-board-dialog-add-repository": true }).props.onClick(),
    );
    expect(mock.action).toHaveBeenCalledWith("/api/repositories", {
      path: "/work/typed/",
      title: "typed",
      by: "person",
    });
    expect(repositorySelect().props.value).toBe("r5");
    expect(baseSelect().props.value).toBe("main");
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
