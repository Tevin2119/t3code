import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { parseTask } from "../../lib/delivery";
import type { MoveBoard } from "../../lib/deliveryMove";
import { MoveTaskDialog } from "./MoveTaskDialog";
const mock = vi.hoisted(() => ({
  reading: { body: null as unknown, error: null as string | null },
  action: vi.fn(),
  branches: {} as Record<string, unknown>,
  targets: [] as unknown[],
  list: null as unknown,
  scroll: { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 },
}));
vi.mock("../../state/queries", () => ({
  usePaginatedBranches: (target: {
    environmentId: string | null;
    cwd: string | null;
    query: string;
  }) => {
    mock.targets.push(target);
    return (
      mock.branches[JSON.stringify([target.environmentId, target.cwd, target.query])] ??
      branchState(null, { isPending: true })
    );
  },
}));
vi.mock("../../state/delivery", () => ({
  useDeliveryRead: () => mock.reading,
  useDeliveryAct: () => mock.action,
  usePersonName: () => "person",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: ReadonlyArray<string>;
    renderItem: (row: { item: string; index: number }) => unknown;
    ref: { current: unknown };
    onLayout: () => void;
    onScroll: () => void;
  }) => {
    mock.list = props;
    props.ref.current = {
      getScrollableNode: () => mock.scroll,
      scrollToOffset: () => undefined,
      scrollIndexIntoView: () => undefined,
    };
    return props.data.map((item, index) => props.renderItem({ item, index }));
  },
}));
vi.mock("../ui/combobox", () => ({
  Combobox: "combobox-root",
  ComboboxTrigger: "combobox-trigger",
  ComboboxPopup: "combobox-popup",
  ComboboxSearchInput: "combobox-input",
  ComboboxItem: "combobox-item",
  ComboboxEmpty: "combobox-empty",
  ComboboxListVirtualized: "combobox-list",
  ComboboxStatus: "combobox-status",
}));
vi.mock("../ui/select", () => ({
  Select: "select-root",
  SelectTrigger: "select-trigger",
  SelectValue: "output",
  SelectPopup: "select-popup",
  SelectItem: "select-item",
  SelectGroup: "select-group",
  SelectGroupLabel: "select-group-label",
  SelectButton: "select-button",
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
type BranchRef = {
  name: string;
  isRemote?: boolean;
  remoteName?: string;
  current?: boolean;
  isDefault?: boolean;
};
const branchRefs = (names: ReadonlyArray<string | BranchRef>) =>
  names.map((ref) => ({
    current: false,
    isDefault: false,
    worktreePath: null,
    ...(typeof ref === "string" ? { name: ref } : ref),
  }));
const branchActions = { refresh: vi.fn(), loadNext: vi.fn() };
/** The shape usePaginatedBranches answers with; `names` null while nothing is read. */
function branchState(
  names: ReadonlyArray<string | BranchRef> | null,
  extra: Partial<{
    nextCursor: number | null;
    totalCount: number;
    isRepo: boolean;
    error: string | null;
    isPending: boolean;
    isFetchingNextPage: boolean;
  }> = {},
) {
  const refs = names ? branchRefs(names) : [];
  return {
    data: names
      ? {
          refs,
          nextCursor: extra.nextCursor ?? null,
          isRepo: extra.isRepo ?? true,
          hasPrimaryRemote: true,
          totalCount: extra.totalCount ?? refs.length,
        }
      : null,
    refs,
    error: extra.error ?? null,
    isPending: extra.isPending ?? false,
    isFetchingNextPage: extra.isFetchingNextPage ?? false,
    refresh: branchActions.refresh,
    loadNext: branchActions.loadNext,
  };
}
const branchKey = (environmentId: string, cwd: string, query = "") =>
  JSON.stringify([environmentId, cwd, query]);

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}

const ENV = EnvironmentId.make("env-a");
const board = (id = "a", base = "main", path: string | null = `/${id}`): MoveBoard => ({
  id,
  title: id,
  target: { repository: id, title: id, path, base, ok: true, problem: null },
});
const repo = (extra: Record<string, unknown> = {}) => ({
  id: "a",
  path: "/a",
  branches: ["main"],
  delivery: { mode: "publish", remote: "origin" },
  fetch: { remote: "origin" },
  ...extra,
});
const remote = (name: string, remoteName?: string) => ({
  name,
  isRemote: true,
  ...(remoteName === undefined ? {} : { remoteName }),
});
describe("MoveTaskDialog", () => {
  let renderer: ReactTestRenderer | undefined;
  let boards: MoveBoard[];
  const view = () => (
    <MoveTaskDialog
      environmentId={ENV}
      task={parseTask({ id: "task", number: 1, card: {} })!}
      boards={boards}
      board="a"
      onClose={() => undefined}
      onMoved={() => undefined}
    />
  );
  const render = async () => {
    await act(() => {
      if (renderer) renderer.update(view());
      else renderer = create(view());
    });
  };
  const root = () => renderer!.root;
  const picker = () => root().findByType("combobox-root" as never);
  const confirm = () => root().findByProps({ "data-move-task-confirm": true });
  const options = () =>
    root()
      .findAllByType("combobox-item" as never)
      .map((n) => n.props.value);
  const missing = () => root().findAllByProps({ "data-move-task-base-missing": true });
  const open = async () => {
    await act(() => picker().props.onOpenChange(true));
  };
  const search = async (value: string) => {
    await act(() =>
      root()
        .findByType("combobox-input" as never)
        .props.onChange({ target: { value } }),
    );
  };
  const choose = async (value: string) => {
    await act(() =>
      root()
        .findAllByType("combobox-item" as never)
        .find((n) => n.props.value === value)!
        .props.onClick(),
    );
  };
  const move = async () => {
    await act(() => confirm().props.onClick());
  };
  const page = (
    names: Parameters<typeof branchState>[0],
    query = "",
    extra: Parameters<typeof branchState>[1] = {},
    cwd = "/a",
  ) => {
    const state = branchState(names, extra);
    mock.branches[branchKey(ENV, cwd, query)] = state;
    return state;
  };
  beforeEach(() => {
    boards = [board()];
    mock.reading = { body: [repo()], error: null };
    mock.action = vi.fn().mockResolvedValue({ ok: true });
    mock.branches = {};
    mock.targets = [];
    branchActions.loadNext.mockClear();
    page(["main", "feature/demo"]);
  });
  afterEach(async () => {
    await act(() => renderer?.unmount());
    renderer = undefined;
  });
  it("preselects the verified default and submits only a relocate action", async () => {
    await render();
    expect(picker().props.value).toBe("main");
    expect(confirm().props.disabled).toBe(false);
    await open();
    expect(options()).toEqual(["main", "feature/demo"]);
    expect(text(root())).toContain("(default)");
    await move();
    expect(mock.action.mock.calls).toEqual([
      ["/api/tasks/task/relocate", { board: "a", base: "main", by: "person" }],
    ]);
  });
  it("lists and filters destination refs, retaining the default when search hides it", async () => {
    page(["feature/demo"], "feature");
    await render();
    await open();
    await search("feature");
    expect(options()).toEqual(["feature/demo"]);
    expect(picker().props.value).toBe("main");
    expect(confirm().props.disabled).toBe(false);
    expect(missing()).toHaveLength(0);
    await choose("feature/demo");
    await move();
    expect(mock.action).toHaveBeenCalledWith("/api/tasks/task/relocate", {
      board: "a",
      base: "feature/demo",
      by: "person",
    });
  });
  it("replaces options and resets search and explicit selection on destination change", async () => {
    boards.push(board("b", "release"));
    page(["release", "other"], "", {}, "/b");
    await render();
    await choose("feature/demo");
    await search("feature");
    await act(() =>
      root()
        .findByType("select-root" as never)
        .props.onValueChange("b"),
    );
    expect(picker().props.value).toBe("release");
    expect(options()).toEqual(["release", "other"]);
    expect(root().findByType("combobox-input" as never).props.value).toBe("");
    expect(mock.targets).toContainEqual({ environmentId: ENV, cwd: "/b", query: "" });
    await move();
    expect(mock.action.mock.calls[0]?.[1]).toEqual({ board: "b", base: "release", by: "person" });
  });
  it.each(["boards", "branches", "repositories"])(
    "seeds the default when %s arrive late",
    async (kind) => {
      if (kind === "boards") boards = [];
      if (kind === "branches") page(null, "", { isPending: true });
      if (kind === "repositories") {
        boards = [board("a", "release")];
        mock.reading.body = [];
        page(["main", remote("origin/release")]);
      }
      await render();
      expect(confirm().props.disabled).toBe(true);
      boards = [board("a", kind === "repositories" ? "release" : "main")];
      mock.reading.body = [repo()];
      page(["main", remote("origin/release")]);
      await render();
      expect(picker().props.value).toBe(kind === "repositories" ? "release" : "main");
      expect(confirm().props.disabled).toBe(false);
    },
  );
  it("offers no free-text base input or create/checkout actions and cannot submit search text", async () => {
    boards = [board("a", "gone")];
    page([], "invented");
    await render();
    expect(root().findAllByType("input" as never)).toHaveLength(0);
    await open();
    await search("invented");
    expect(options()).toEqual([]);
    expect(text(root())).not.toMatch(/Create branch|Checkout pull request/);
    await move();
    expect(mock.action).not.toHaveBeenCalled();
  });
  it.each([null, "Engine offline"])(
    "reports an absent board base even with repository error %s",
    async (error) => {
      boards = [board("a", "gone")];
      mock.reading = { body: null, error };
      await render();
      expect(missing()).toHaveLength(1);
      expect(options()).not.toContain("gone");
      expect(text(root())).not.toContain("(default)");
      expect(confirm().props.disabled).toBe(true);
      await move();
      expect(mock.action).not.toHaveBeenCalled();
    },
  );
  it("explains empty eligible lists", async () => {
    page([]);
    await render();
    expect(text(root())).toContain("No branches are available");
    expect(confirm().props.disabled).toBe(true);
  });
  it.each(["missing", "error", "not-repo"])("explains an unreachable folder: %s", async (kind) => {
    if (kind === "missing") {
      boards = [board("a", "main", null)];
      mock.reading.body = [];
    } else
      page(["main"], "", kind === "error" ? { error: "Folder unavailable" } : { isRepo: false });
    await render();
    expect(root().findAllByProps({ "data-move-task-base-unreachable": true })).toHaveLength(1);
    await move();
    expect(mock.action).not.toHaveBeenCalled();
  });
  it.each(["origin", "/repos/remote.git", "https://example.com/repo.git"])(
    "offers remote-only defaults and non-defaults using resolved remote for %s",
    async (source) => {
      const resolved = source === "origin" ? "origin" : "delivery-123";
      mock.reading.body = [
        repo({
          delivery: { mode: "publish", remote: source },
          fetch: { remote: resolved },
          branches: ["main"],
        }),
      ];
      boards = [
        { ...board("a", "release"), target: { ...board("a", "release").target!, ok: true } },
      ];
      page([
        "main",
        remote(`${resolved}/release`, source === "origin" ? resolved : undefined),
        remote(`${resolved}/hotfix`, source === "origin" ? resolved : undefined),
      ]);
      await render();
      expect(picker().props.value).toBe("release");
      expect(confirm().props.disabled).toBe(false);
      await open();
      expect(options()).toEqual(["release", "main", "hotfix"]);
      expect(text(root())).toContain("(default)");
      await move();
      expect(mock.action.mock.calls[0]?.[1].base).toBe("release");
      await choose("hotfix");
      await move();
      expect(mock.action.mock.calls[1]?.[1].base).toBe("hotfix");
    },
  );
  it.each(["wrong", "local", "absent"])("excludes ineligible remotes: %s", async (kind) => {
    boards = [board("a", "release")];
    mock.reading.body = [
      repo(
        kind === "local"
          ? { delivery: { mode: "local", remote: "origin" } }
          : kind === "absent"
            ? { delivery: null }
            : {},
      ),
    ];
    page([
      "main",
      remote("other/release", "other"),
      ...(kind === "wrong" ? [] : [remote("origin/release")]),
    ]);
    await render();
    expect(options()).toEqual(["main"]);
    expect(confirm().props.disabled).toBe(true);
  });
  it("deduplicates a local and resolved remote branch while preserving slashes", async () => {
    mock.reading.body = [repo({ fetch: { remote: "delivery-123" } })];
    page(["main", "feature/demo", remote("delivery-123/feature/demo", undefined)]);
    await render();
    expect(options()).toEqual(["main", "feature/demo"]);
    await choose("feature/demo");
    await move();
    expect(mock.action.mock.calls[0]?.[1].base).toBe("feature/demo");
  });
  it("keeps an explicitly searched selection beyond unfiltered pages", async () => {
    page(["main"], "", { nextCursor: 10 });
    page(["deep"], "deep");
    await render();
    await search("deep");
    await choose("deep");
    page(["main", "other"], "", { nextCursor: 20 });
    await render();
    expect(picker().props.value).toBe("deep");
    await move();
    expect(mock.action.mock.calls[0]?.[1].base).toBe("deep");
  });
  it("auto-pages while closed, through ineligible pages and after finding the default", async () => {
    boards = [board("a", "release")];
    page([remote("other/no", "other")], "", { nextCursor: 10 });
    await render();
    expect(branchActions.loadNext).toHaveBeenCalled();
    branchActions.loadNext.mockClear();
    page(["main", remote("origin/release")], "", { nextCursor: 20 });
    await render();
    expect(picker().props.value).toBe("release");
    expect(branchActions.loadNext).toHaveBeenCalled();
    expect(options()).toEqual(["release", "main"]);
  });
  it.each(["error", "pending", "last", "filled"])("stops automatic paging on %s", async (kind) => {
    page(
      kind === "filled" ? ["main", ...Array.from({ length: 8 }, (_, i) => `branch${i}`)] : ["main"],
      "",
      {
        nextCursor: kind === "last" ? null : 10,
        error: kind === "error" ? "Failed" : null,
        isFetchingNextPage: kind === "pending",
      },
    );
    await render();
    expect(branchActions.loadNext).not.toHaveBeenCalled();
  });
  it("auto-pages searched results with no eligible rows", async () => {
    page([remote("other/hotfix", "other")], "hotfix", { nextCursor: 10 });
    await render();
    await open();
    branchActions.loadNext.mockClear();
    await search("hotfix");
    expect(branchActions.loadNext).toHaveBeenCalled();
  });
});
