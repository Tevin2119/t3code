import { create } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { act } from "../../../test/act";
import { BoardDeploymentControls } from "./BoardDeploymentControls";
import { MergePermissionControls } from "./MergePermissionControls";

const state = vi.hoisted(() => ({ action: vi.fn(), snapshot: null as unknown, stale: false }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/delivery", () => ({
  deliveryEnvironment: { act: { permissionAtom: () => null } },
  useDeliveryAct: () => state.action,
  usePersonName: () => "QA person",
  useBoardStore: (select: (state: { setPerson: () => void }) => unknown) =>
    select({ setPerson: () => {} }),
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

it.each(["board", "catalog"] as const)(
  "blocks open link review and approval when %s loses freshness",
  async (source) => {
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
      link: null,
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
