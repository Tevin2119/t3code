import { create, type ReactTestInstance } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { act } from "../../../test/act";
import { BoardDeploymentControls } from "./BoardDeploymentControls";
import { MergePermissionControls } from "./MergePermissionControls";

const state = vi.hoisted(() => ({
  action: vi.fn(),
  snapshot: null as unknown,
  stale: false,
  allowed: true,
  person: "QA person",
}));
vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  useGT:
    () =>
    (text: string, vars: Record<string, string> = {}) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? ""),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../RelativeTime", () => ({
  RelativeTime: ({ timestamp }: { timestamp: string }) => `when ${timestamp}`,
}));
vi.mock("../../state/delivery", () => ({
  deliveryEnvironment: { act: { permissionAtom: () => null } },
  useDeliveryAct: () => state.action,
  usePersonName: () => state.person.trim(),
  useBoardStore: (select: (value: { person: string; setPerson: () => void }) => unknown) =>
    select({ person: state.person, setPerson: () => {} }),
  useDeliveryRead: () => ({
    body: state.snapshot,
    readAt: "2000-01-01T00:00:00Z",
    error: null,
    isPending: false,
    refresh: () => {},
  }),
  useStaleReading: () => state.stale,
}));
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

function setup(input: { allowed?: boolean; person?: string } = {}) {
  state.allowed = input.allowed ?? true;
  state.person = input.person ?? "QA person";
  state.stale = false;
}

it("refuses linking when the board-link capability is absent", async () => {
  setup();
  state.action.mockReset();
  state.stale = false;
  state.snapshot = null;
  let view!: ReturnType<typeof create>;
  await act(() => {
    view = create(
      <BoardDeploymentControls
        environmentId={"host" as never}
        board="work"
        target={{ repository: "app", base: "main", title: "App", ok: true } as never}
        link={null}
        stale={false}
        onDone={() => {}}
      />,
    );
  });
  try {
    const link = view.root
      .findAllByType("button")
      .find(
        (node) =>
          node.children.filter((child) => typeof child === "string").join("") ===
          "Link deployment…",
      );
    // Not offered at all: an engine that reports no link would refuse one.
    expect(link).toBeUndefined();
    expect(state.action).not.toHaveBeenCalled();
  } finally {
    await act(() => view.unmount());
  }
});

it.each(["board", "catalog"] as const)(
  "blocks open link review and approval when %s loses freshness",
  async (source) => {
    setup();
    state.action.mockReset().mockResolvedValue({ ok: true });
    state.stale = false;
    state.snapshot = {
      version: 1,
      projects: [
        {
          id: "deploy-production",
          repository: "app",
          title: "App",
          environment: "production",
          branch: "main",
          mode: "manual",
          adapter: "command",
          latestCommit: null,
          liveCommit: null,
        },
      ],
      candidates: [],
      repositories: [],
      capabilities: { engine: false, command: true },
    };
    const props = {
      environmentId: "host" as never,
      board: "work",
      target: { repository: "app", base: "main", title: "App", ok: true } as never,
      link: { state: "unlinked", deploymentProjectId: null, project: null, problem: null } as never,
      stale: false,
      onDone: () => {},
    };
    let view!: ReturnType<typeof create>;
    await act(() => {
      view = create(<BoardDeploymentControls {...props} />);
    });
    try {
      const button = (text: string) =>
        view.root
          .findAllByType("button")
          .find((n) => n.children.filter((x) => typeof x === "string").join("") === text)!;
      await act(() => button("Link deployment…").props.onClick());
      await act(() => view.root.findByType("select").props.onValueChange("deploy-production"));
      state.stale = source === "catalog";
      await act(() =>
        view.update(<BoardDeploymentControls {...props} stale={source === "board"} />),
      );
      expect(button("Review link…").props.disabled).toBe(true);
      state.stale = false;
      await act(() => view.update(<BoardDeploymentControls {...props} />));
      expect(button("Review link…").props.disabled).toBe(false);
      await act(() => button("Review link…").props.onClick());
      await act(() =>
        view.root
          .findAllByType("input")
          .find((n) => n.props.type === "password")!
          .props.onChange({ target: { value: "test-only-key" } }),
      );
      expect(button("Link deployment").props.disabled).toBe(false);
      state.stale = source === "catalog";
      await act(() =>
        view.update(<BoardDeploymentControls {...props} stale={source === "board"} />),
      );
      expect(button("Link deployment").props.disabled).toBe(true);
      state.stale = false;
      await act(() => view.update(<BoardDeploymentControls {...props} />));
      expect(button("Link deployment").props.disabled).toBe(true);
      await act(() => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
      expect(state.action).not.toHaveBeenCalled();
    } finally {
      await act(() => view.unmount());
    }
  },
);

it("allows unlinking a fresh invalid link but requires a new review after stale data", async () => {
  setup();
  state.action.mockReset().mockResolvedValue({ ok: true });
  const props = {
    environmentId: "host" as never,
    board: "work",
    target: null,
    link: {
      deploymentProjectId: "removed-project",
      state: "invalid" as const,
      problem: "The linked deployment project is missing. Explicitly relink or unlink the board.",
      project: null,
      by: null,
      at: null,
    },
    stale: false,
    onDone: () => {},
  };
  let view!: ReturnType<typeof create>;
  await act(() => {
    view = create(<BoardDeploymentControls {...props} />);
  });
  try {
    const button = (label: string) =>
      view.root
        .findAllByType("button")
        .find(
          (node) => node.children.filter((child) => typeof child === "string").join("") === label,
        )!;
    const key = () =>
      view.root
        .findAllByType("input")
        .find((node) => node.props.type === "password")!
        .props.onChange({ target: { value: "test-only-key" } });
    await act(() => button("Unlink…").props.onClick());
    await act(key);
    expect(button("Unlink deployment").props.disabled).toBe(false);
    await act(() => view.update(<BoardDeploymentControls {...props} stale />));
    await act(() => view.update(<BoardDeploymentControls {...props} />));
    expect(button("Unlink deployment").props.disabled).toBe(true);
    await act(() => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(state.action).not.toHaveBeenCalled();
    await act(() => button("Cancel").props.onClick());
    await act(() => button("Unlink…").props.onClick());
    await act(key);
    expect(button("Unlink deployment").props.disabled).toBe(false);
    await act(() => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(state.action).toHaveBeenCalledExactlyOnceWith("/api/boards/work/deployment", {
      deploymentProjectId: null,
      by: "QA person",
      key: "test-only-key",
    });
  } finally {
    await act(() => view.unmount());
  }
});

it("invalidates an open merge approval when its snapshot becomes stale", async () => {
  setup();
  state.action.mockReset().mockResolvedValue({ ok: true });
  const policy = {
    setting: "inherit",
    resolved: "off",
    eligible: false,
    source: "fallback",
    sourceId: null,
    by: null,
    since: null,
    requestedBy: null,
    requestedSince: null,
    mode: "streamlined",
    execution: "guarded",
    problem: null,
    blockingReason: "permission-off",
    board: "work",
  } as const;
  const props = {
    environmentId: "host" as never,
    path: "/api/boards/work/merge-permission",
    policy,
    stale: false,
    onDone: () => {},
  };
  let view!: ReturnType<typeof create>;
  await act(() => {
    view = create(<MergePermissionControls {...props} />);
  });
  try {
    const button = (text: string) =>
      view.root
        .findAllByType("button")
        .find((n) => n.children.filter((x) => typeof x === "string").join("") === text)!;
    await act(() => view.root.findByType("select").props.onValueChange("on"));
    await act(() => button("Save permission…").props.onClick());
    await act(() => view.root.findByType("checkbox" as never).props.onCheckedChange(true));
    await act(() =>
      view.root
        .findAllByType("input")
        .find((n) => n.props.type === "password")!
        .props.onChange({ target: { value: "test-only-key" } }),
    );
    await act(() => view.update(<MergePermissionControls {...props} stale />));
    expect(button("Save permission…").props.disabled).toBe(true);
    expect(button("Save merge permission").props.disabled).toBe(true);
    await act(() => view.update(<MergePermissionControls {...props} />));
    expect(button("Save merge permission").props.disabled).toBe(true);
    await act(() => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(state.action).not.toHaveBeenCalled();
  } finally {
    await act(() => view.unmount());
  }
});

// The board deployment states of BOARD-REVAMP-UI-SPEC section 3.
const linkProject = {
  id: "deploy-1",
  repository: "app",
  path: "/real/app",
  environment: "staging",
  branch: "main",
  mode: "auto-qualify",
  title: "App",
};
const unlinkedLink = {
  deploymentProjectId: null,
  state: "unlinked" as const,
  problem: null,
  by: null,
  at: null,
  project: null,
};
const words = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : words(child))).join("");
async function renderLink(link: unknown, run: (root: ReactTestInstance) => void) {
  let view!: ReturnType<typeof create>;
  await act(() => {
    view = create(
      <BoardDeploymentControls
        environmentId={"host" as never}
        board="work"
        target={{
          repository: "app",
          base: "main",
          title: "App",
          path: "/real/app",
          ok: true,
          problem: null,
        }}
        link={link as never}
        stale={false}
        onDone={() => {}}
      />,
    );
  });
  try {
    run(view.root);
  } finally {
    await act(() => view.unmount());
  }
}
const buttonLabels = (root: ReactTestInstance) => root.findAllByType("button").map(words);
const linkState = (root: ReactTestInstance) =>
  root.find((node) => typeof node.props["data-board-deployment"] === "string").props[
    "data-board-deployment"
  ];

it("not linked, named person: says so and offers the link", async () => {
  setup();
  await renderLink(unlinkedLink, (root) => {
    expect(linkState(root)).toBe("unlinked");
    expect(words(root)).toContain("No deployment project linked");
    expect(buttonLabels(root)).toEqual(["Link deployment…"]);
  });
});

it("not linked, no name: no link button that would be refused, and a field for the name", async () => {
  setup({ person: "" });
  await renderLink(unlinkedLink, (root) => {
    expect(buttonLabels(root)).toEqual([]);
    expect(root.findAll((node) => node.props["data-board-deployment-name"] === true)).toHaveLength(
      1,
    );
  });
});

it("not linked, read-only connection: no link button", async () => {
  setup({ allowed: false });
  await renderLink(unlinkedLink, (root) => {
    expect(buttonLabels(root)).toEqual([]);
    expect(words(root)).toContain("read-only");
  });
});

it("linked: the project, who linked it and when", async () => {
  setup();
  const link = {
    ...unlinkedLink,
    deploymentProjectId: linkProject.id,
    state: "linked",
    by: "Ada",
    at: "2030-01-01T00:00:00.000Z",
    project: linkProject,
  };
  await renderLink(link, (root) => {
    expect(words(root)).toContain("App · staging");
    const by = root.find((node) => node.props["data-board-deployment-by"] === true);
    expect(words(by)).toBe("Linked by Ada · when 2030-01-01T00:00:00.000Z");
    expect(buttonLabels(root)).toEqual(["Relink…", "Unlink…"]);
  });
});

it("link has a problem: the engine's text, unchanged", async () => {
  setup();
  const problem = "Project watch branch changed (watchRevision 3); relink explicitly.";
  const link = { ...unlinkedLink, deploymentProjectId: linkProject.id, state: "invalid", problem };
  await renderLink(link, (root) => {
    expect(linkState(root)).toBe("invalid");
    const notice = root.find(
      (node) => node.props["data-delivery-diagnostic"] === "missing-deployment",
    );
    expect(notice.findAllByType("p").map(words)).toContain(problem);
  });
});
