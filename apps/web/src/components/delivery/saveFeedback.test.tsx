import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BoardSeatsDialog } from "./BoardSeatsDialog";
import { ProfilePage } from "./ProfilePage";
import { TeamDefaultsDialog } from "./TeamDefaultsDialog";

const mock = vi.hoisted(() => ({
  action: vi.fn(),
  navigate: vi.fn(),
  refresh: vi.fn(),
  bodies: {} as Record<string, unknown>,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mock.navigate,
  useSearch: () => ({ name: "mine" }),
}));
vi.mock("../../state/delivery", async (original) => ({
  ...(await original<typeof import("../../state/delivery")>()),
  useDeliveryAct: () => mock.action,
  useDeliveryRead: (_environment: unknown, path: string | null) => ({
    body: path ? mock.bodies[path] : null,
    error: null,
    refresh: mock.refresh,
  }),
  useDeliveryEnvironmentId: () => EnvironmentId.make("env-a"),
  useDeliveryEnabled: () => true,
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
vi.mock("../ui/select", () => ({
  Select: "select-root",
  SelectTrigger: "select-trigger",
  SelectValue: "output",
  SelectPopup: "select-popup",
  SelectItem: "select-item",
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "tooltip-root",
  TooltipTrigger: "tooltip-trigger",
  TooltipPopup: "tooltip-popup",
}));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "scroll-area" }));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "sidebar-inset" }));
vi.mock("./SeatSettingsPanel", () => ({
  SeatSettingsPanel: "seat-settings",
  useSeatCatalog: () => ({ entries: [], options: {} }),
}));
vi.mock("./SetupPanel", () => ({ SetupPanel: "setup-panel" }));
vi.mock("./TrackRecord", () => ({ TrackRecord: "track-record" }));
vi.mock("./FallbacksEditor", () => ({ FallbacksEditor: "fallbacks-editor" }));
vi.mock("./Behind", () => ({ Behind: "behind-read" }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: "model-picker" }));

const environmentId = EnvironmentId.make("env-a");
const profile = { profile: "mine", name: "mine", editable: true, revision: 3, seats: [] };
const defaults = { team: "alpha" };
const board = { teams: [{ team: "alpha", revision: 1, seats: [] }] };
const noteCases = [
  { label: "empty", fields: { note: "" }, expected: "Saved." },
  { label: "non-empty", fields: { note: "Noted" }, expected: "Noted" },
  { label: "omitted", fields: {}, expected: "Saved." },
  { label: "null", fields: { note: null }, expected: "Saved." },
  { label: "whitespace", fields: { note: "  " }, expected: "  " },
];
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.action.mockReset();
  mock.refresh.mockReset();
  mock.navigate.mockReset();
  mock.bodies = {
    "/api/profiles": [profile],
    "/api/profiles/mine": profile,
    "/api/teams/alpha/defaults": defaults,
    "/api/boards/board-1/seats": board,
  };
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it.each(noteCases)(
  "ProfileEditor shows confirmation for $label notes",
  async ({ fields, expected }) => {
    mock.action.mockResolvedValue({ ok: true, body: { ...profile, ...fields } });
    await act(() => {
      renderer = create(<ProfilePage />);
    });
    expect(renderer!.root.findByProps({ "data-profile-save": true }).props.disabled).toBe(true);
    await act(() => {
      renderer!.root.findByProps({ "aria-label": "Purpose" }).props.onChange({
        target: { value: "Changed purpose" },
      });
    });
    const save = renderer!.root.findByProps({ "data-profile-save": true });
    expect(save.props.disabled).toBe(false);
    await act(async () => save.props.onClick());
    expect(mock.action).toHaveBeenCalledWith(
      "/api/profiles/mine",
      expect.objectContaining({ purpose: "Changed purpose" }),
    );
    expect(renderer!.root.findByProps({ "data-profile-said": true }).children).toEqual([expected]);
  },
);

it.each(noteCases)(
  "TeamDefaultsDialog shows confirmation for $label notes",
  async ({ fields, expected }) => {
    mock.action.mockResolvedValue({ ok: true, body: { ...defaults, ...fields } });
    await act(() => {
      renderer = create(
        <TeamDefaultsDialog environmentId={environmentId} team="alpha" onClose={() => {}} />,
      );
    });
    const save = renderer!.root
      .findAllByType("button")
      .find((node) => node.children.includes("Save defaults"))!;
    expect(save.props.disabled).toBe(false);
    await act(async () => save.props.onClick());
    expect(mock.action).toHaveBeenCalledWith("/api/teams/alpha/defaults", expect.anything());
    expect(renderer!.root.findAllByType("p").map((node) => node.children.join(""))).toContain(
      expected,
    );
  },
);

it.each(noteCases)(
  "BoardSeatsDialog shows confirmation for $label notes",
  async ({ fields, expected }) => {
    mock.action.mockResolvedValue({ ok: true, body: { ...board, ...fields } });
    await act(() => {
      renderer = create(
        <BoardSeatsDialog
          environmentId={environmentId}
          board={{ id: "board-1", title: "Board" }}
          onClose={() => {}}
        />,
      );
    });
    const save = renderer!.root
      .findAllByType("button")
      .find((node) => node.children.includes("Save for this board"))!;
    expect(save.props.disabled).toBe(false);
    await act(async () => save.props.onClick());
    expect(mock.action).toHaveBeenCalledWith("/api/boards/board-1/seats", expect.anything());
    expect(renderer!.root.findAllByType("p").map((node) => node.children.join(""))).toContain(
      expected,
    );
  },
);
