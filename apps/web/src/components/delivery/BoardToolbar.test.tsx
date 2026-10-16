// @vitest-environment jsdom

import { EnvironmentId } from "@t3tools/contracts";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { EnginePanel } from "./EnginePanel";
import { BoardToolbar, type BoardToolbarProps } from "./BoardToolbar";
import { BoardEngineNotice, BoardNotice } from "./BoardEngineNotice";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { parseCard } from "../../lib/delivery";
import { BoardPicker } from "./BoardPicker";
import { NO_FILTERS } from "../../lib/deliveryBoard";

vi.mock("./BoardPicker.browse", () => ({ RepositoryBrowse: () => null }));
vi.mock("./BoardPicker.branches", () => ({ BaseBranchPicker: () => null }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const mock = vi.hoisted(() => ({
  read: { body: null as unknown, error: null, isPending: false, refresh: vi.fn() },
  action: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ cwd: "/test" }) }));
vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: () => "pm" }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ label: "Test" }),
  useEnvironments: () => ({
    isReady: true,
    environments: ["local", "remote"].map((environmentId) => ({
      environmentId,
      label: environmentId === "local" ? "Local machine" : "Remote machine",
      displayUrl: null,
      serverConfig: null,
      connection: { phase: "connected", error: null },
    })),
  }),
}));
vi.mock("../../state/delivery", () => ({
  useDeliveryRead: () => mock.read,
  useDeliveryAct: () => mock.action,
  useDeliveryEnabled: () => true,
}));
vi.mock("../../state/server", () => ({
  primaryServerKeybindingsAtom: {},
  serverEnvironment: { configValueAtom: () => ({}) },
}));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: { open: {}, write: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));

let root: Root;
let container: HTMLDivElement;
let desktop = false;
const mediaListeners = new Set<() => void>();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (media: string) => ({
    get matches() {
      return media === "(min-width: 768px)" && desktop;
    },
    media,
    addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
  }));
  desktop = false;
  mediaListeners.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mock.action.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function ResponsiveControls({ portrait }: { portrait: boolean }) {
  const portal = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  return (
    <>
      <button onClick={() => setOpen(true)}>Filters</button>
      <div ref={portal} />
      <Sheet open={portrait && open} modal={portrait} onOpenChange={setOpen}>
        <SheetPopup side="bottom" container={portal} keepMounted inline={!portrait}>
          <SheetTitle>Board filters</SheetTitle>
          <input
            aria-label="Owner"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </SheetPopup>
      </Sheet>
      <EnginePanel environmentId={EnvironmentId.make("local")} compact={portrait} />
    </>
  );
}

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}

function button(label: string) {
  const found = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function render(portrait: boolean) {
  await act(async () => root.render(<ResponsiveControls portrait={portrait} />));
}

const defaultOptions: Partial<BoardToolbarProps> = {};

function ToolbarFixture({ options = defaultOptions }: { options?: Partial<BoardToolbarProps> }) {
  const [filters, setFilters] = useState(options.filters ?? NO_FILTERS);
  const [board, setBoard] = useState("travel");
  const [grouping, setGrouping] = useState(options.grouping ?? "none");
  const [environment, setEnvironment] = useState("local");
  return (
    <BoardToolbar
      environmentId={EnvironmentId.make("local")}
      environmentPicker={
        <EnvironmentPicker value={EnvironmentId.make(environment)} onChoose={setEnvironment} />
      }
      boardPicker={
        <BoardPicker
          label="Board"
          marker="board"
          value={board}
          items={[
            { id: "travel", title: "Travel", description: "Work while travelling", kind: "own" },
          ]}
          everything={{ id: "all", label: "Show every task" }}
          newLabel="New board"
          onChoose={setBoard}
          onCreate={vi.fn()}
          onEdit={vi.fn()}
        />
      }
      viewPicker={
        <BoardPicker
          label="View"
          marker="view"
          value="development"
          items={[
            {
              id: "development",
              title: "Development",
              description: "Build and review",
              kind: "builtin",
            },
          ]}
          newLabel="New view"
          onChoose={vi.fn()}
          onCreate={vi.fn()}
          onEdit={vi.fn()}
        />
      }
      help={null}
      view="development"
      cards={[]}
      lanes={[]}
      waiting={0}
      shared={false}
      enabled
      status="Up to date"
      pending={false}
      onFilters={(patch) => setFilters((current) => ({ ...current, ...patch }))}
      onGrouping={setGrouping}
      onReset={() => setFilters(NO_FILTERS)}
      onNew={vi.fn()}
      onRefresh={vi.fn()}
      {...options}
      environmentChanged={options.environmentChanged || environment !== "local"}
      filters={filters}
      grouping={grouping}
    />
  );
}

async function toolbar(portrait: boolean, options: Partial<BoardToolbarProps> = {}) {
  await act(async () => {
    desktop = !portrait;
    mediaListeners.forEach((listener) => listener());
    root.render(<ToolbarFixture options={options} />);
  });
}

describe("responsive board control ownership", () => {
  it("opens the full engine notice from its compact action", async () => {
    const message = "A long engine failure notice with diagnostic information for the traveller.";
    await act(async () =>
      root.render(
        <BoardEngineNotice environmentId={EnvironmentId.make("local")} message={message} />,
      ),
    );
    const opener = button("Read engine notice");
    opener.focus();
    expect(document.activeElement).toBe(opener);
    await click("Read engine notice");
    expect(element('[data-slot="dialog-popup"]').textContent).toContain(message);
    expect(element('[data-slot="dialog-popup"]').textContent).toContain(
      "Open Engine beside the environment picker",
    );
    await click("Close");
    expect(element('[data-slot="dialog-popup"]').hasAttribute("data-closed")).toBe(true);
  });
  it("opens a collapsed board notice with its full original content", async () => {
    await act(async () =>
      root.render(
        <BoardNotice summary="A short notice">
          <p>Full board notice and recovery instructions.</p>
        </BoardNotice>,
      ),
    );
    await click("Read engine notice");
    expect(element('[data-slot="dialog-popup"]').textContent).toContain(
      "Full board notice and recovery instructions.",
    );
  });
  it("keeps controls and their parentage through sheet opening, dismissal and breakpoint crossings", async () => {
    await render(false);
    const owner = element<HTMLInputElement>('input[aria-label="Owner"]');
    const parent = owner.parentElement;
    await type(owner, "traveller");
    await render(true);
    await click("Filters");
    expect(element('input[aria-label="Owner"]')).toBe(owner);
    expect(owner.parentElement).toBe(parent);
    expect(element('[data-slot="sheet-popup"]').getAttribute("role")).toBe("dialog");

    await render(false);
    expect(element('input[aria-label="Owner"]')).toBe(owner);
    expect(owner.value).toBe("traveller");
    expect(owner.parentElement).toBe(parent);
    const popup = element('[data-slot="sheet-popup"]');
    expect(popup.getAttribute("role")).toBeNull();
    expect(popup.hidden).toBe(false);
    expect(popup.closest("[inert]")).toBeNull();
    expect(document.body.style.overflow).not.toBe("hidden");
    owner.focus();
    expect(document.activeElement).toBe(owner);

    await render(true);
    await click("Filters");
    await click("Close");
    await render(false);
    expect(element('input[aria-label="Owner"]')).toBe(owner);
    expect(owner.value).toBe("traveller");
  });

  it("retains the real engine dialog and an update in flight until its matching completion", async () => {
    const commit = "c".repeat(40);
    const versions = {
      channel: "qa",
      running: { commit: "a".repeat(40), changed: false },
      installed: { commit: "a".repeat(40), changed: false },
      available: { commit, at: "2026-10-16T12:00:00Z" },
      updateAvailable: true,
      restartRequired: false,
      deferred: false,
      managed: true,
      pinned: true,
      problem: null,
      update: null,
    };
    mock.read.body = { approval: "passphrase", versions };
    let accept: (value: unknown) => void = () => {};
    mock.action.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve;
      }),
    );
    await toolbar(true);
    await click("PaperClip engine controls");
    const approval = element<HTMLInputElement>('input[name="delivery-engine-approval"]');
    const dialog = element('[data-slot="dialog-popup"]');
    await type(approval, "approval");
    await click("Update now");
    expect(mock.action).toHaveBeenCalledTimes(1);
    for (const portrait of [false, true, false, true]) {
      await toolbar(portrait);
      expect(element('[data-slot="dialog-popup"]')).toBe(dialog);
      expect(element('input[name="delivery-engine-approval"]')).toBe(approval);
      expect(approval.disabled).toBe(true);
      expect(button("Update now").disabled).toBe(true);
    }
    await act(async () =>
      accept({ ok: true, body: { accepted: true, id: "update-1", commit, channel: "qa" } }),
    );
    await toolbar(false);
    expect(document.body.textContent).toContain("Wait for the matching completion receipt");
    expect(button("Update now").disabled).toBe(true);
    await act(async () => {
      mock.read.body = {
        approval: "passphrase",
        versions: {
          ...versions,
          running: { commit, changed: false },
          update: {
            id: "update-1",
            phase: "complete",
            channel: "qa",
            commit,
            at: "2026-10-16T12:01:00Z",
          },
        },
      };
      root.render(<ToolbarFixture />);
    });
    expect(element('[data-slot="dialog-popup"]')).toBe(dialog);
    expect(document.body.textContent).not.toContain("Wait for the matching completion receipt");
    expect(mock.action).toHaveBeenCalledTimes(1);
  });

  it("expands one search input in place, retains its query and focus path through Escape and crossings", async () => {
    await toolbar(true);
    const search = element<HTMLInputElement>('input[aria-label="Search tasks"]');
    await click("Search the board");
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(search);
    await type(search, "travelling");
    expect(button("Board filters")).toBeDefined();
    await act(async () =>
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(search.value).toBe("travelling");
    expect(document.activeElement).toBe(button("Search the board"));
    await toolbar(false);
    await toolbar(true);
    await click("Search the board");
    expect(element('input[aria-label="Search tasks"]')).toBe(search);
    expect(search.value).toBe("travelling");
    expect(document.querySelectorAll('input[aria-label="Search tasks"]')).toHaveLength(1);
    expect(document.querySelector("[data-board-search-toggle]")).toBeNull();
  });

  it.each([
    { environmentChanged: true },
    { grouping: "team" as const },
    { view: "custom" },
    ...[
      { priority: "high" as const },
      { team: "dev" },
      { owner: "absent-owner" },
      { tags: ["travel"] },
      { lanes: ["ready"] },
      { waiting: true },
    ].map((patch) => ({ filters: { ...NO_FILTERS, ...patch } })),
  ])("indicates a non-default sheet control: %j", async (options) => {
    await toolbar(true, options);
    expect(
      button("Board filters active").querySelector('[aria-label="Active filters"]'),
    ).not.toBeNull();
  });

  it("keeps waiting reversible at zero and clears the active indicator", async () => {
    await toolbar(true);
    await click("Board filters");
    await click("0 waiting on you");
    expect(button("Board filters active")).toBeDefined();
    expect(button("0 waiting on you").getAttribute("aria-pressed")).toBe("true");
    await click("0 waiting on you");
    expect(button("Board filters")).toBeDefined();
    await click("0 waiting on you");
    await click("Clear filters");
    expect(button("Board filters")).toBeDefined();
  });

  it("preserves a real nested board-picker query and control nodes through crossings", async () => {
    await toolbar(true);
    await click("Board");
    const query = element<HTMLInputElement>('input[aria-label="Search board"]');
    await type(query, "travell");
    expect(document.body.textContent).toContain("Work while travelling");
    const boardTrigger = button("Board");
    for (const portrait of [false, true, false, true]) {
      await toolbar(portrait);
      expect(element('input[aria-label="Search board"]')).toBe(query);
      expect(query.value).toBe("travell");
      expect(button("Board")).toBe(boardTrigger);
    }
  });

  it("switches through Show every task and returns to the chosen board", async () => {
    await toolbar(true);
    await click("Board");
    await click("Show every task");
    expect(button("Board").textContent).toBe("all");
    await click("Board");
    await act(async () => element<HTMLElement>('[data-board-picker-option="travel"]').click());
    expect(button("Board").textContent).toBe("Travel");
  });

  it("retains a nested view picker while releasing the sheet's own modality on desktop", async () => {
    await toolbar(true);
    await click("Board filters");
    await click("View");
    const query = element<HTMLInputElement>('input[aria-label="Search view"]');
    await type(query, "review");
    const trigger = button("View");
    await toolbar(false);
    expect(element('input[aria-label="Search view"]')).toBe(query);
    expect(query.value).toBe("review");
    expect(button("View")).toBe(trigger);
    expect(element('[data-slot="sheet-popup"]').getAttribute("role")).toBeNull();
    expect(element('[data-slot="sheet-popup"]').closest("[inert]")).toBeNull();
    await toolbar(true);
    expect(element('input[aria-label="Search view"]')).toBe(query);
    expect(query.value).toBe("review");
  });

  it("keeps a selected owner absent from card results available and clearable", async () => {
    await toolbar(true, { filters: { ...NO_FILTERS, owner: "traveller" } });
    await click("Board filters active");
    await click("Owner");
    expect(document.querySelector('[role="option"][data-selected]')?.textContent).toContain(
      "traveller",
    );
    const clear = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (item) => item.textContent === "Any owner",
    );
    if (!clear) throw new Error("Missing owner clear choice");
    await act(async () => clear.click());
    expect(button("Board filters")).toBeDefined();
    expect(button("Owner").textContent).toBe("Owner");
  });

  it("keeps the real environment picker's query across crossings and switches environments", async () => {
    await toolbar(true);
    await click("Board filters");
    await click("Board workspace: Local machine");
    const query = element<HTMLInputElement>('input[aria-label="Search environments"]');
    await type(query, "remote");
    for (const portrait of [false, true, false, true]) {
      await toolbar(portrait);
      expect(element('input[aria-label="Search environments"]')).toBe(query);
      expect(query.value).toBe("remote");
    }
    const remote = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (item) => item.textContent?.includes("Remote machine"),
    );
    if (!remote) throw new Error("Missing remote environment");
    await act(async () => remote.click());
    expect(button("Board workspace: Remote machine").textContent).toContain("Remote machine");
    expect(button("Board filters active")).toBeDefined();
  });

  it("selects and clears priority, team, grouping, columns and tags with the existing controls", async () => {
    await toolbar(true, {
      cards: [
        parseCard({
          id: "task-travel",
          title: "Travel",
          team: "development",
          owner: "traveller",
          tags: ["travel"],
          lane: "ready",
        }),
      ],
      lanes: [{ lane: "ready", title: "Ready", count: 1 }],
    });
    await click("Board filters");
    const choose = async (trigger: string, label: string) => {
      await click(trigger);
      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (item) => item.textContent === label,
      );
      if (!option) throw new Error(`Missing option ${label}`);
      await act(async () => option.click());
    };
    await choose("Priority", "High");
    expect(button("Priority").textContent).toBe("High");
    await choose("Priority", "Any priority");
    expect(button("Board filters")).toBeDefined();
    await choose("Team", "development");
    expect(button("Team").textContent).toBe("development");
    await choose("Team", "Any team");
    expect(button("Board filters")).toBeDefined();
    await choose("Group cards by", "Priority");
    expect(button("Group cards by").textContent).toBe("By priority");
    await choose("Group cards by", "No grouping");
    expect(button("Board filters")).toBeDefined();
    await click("Filter by column");
    await act(async () => element<HTMLElement>('[data-board-lane-choice="ready"]').click());
    expect(button("Filter by column").textContent).toBe("1 column");
    await act(async () => element<HTMLElement>("[data-board-lane-all]").click());
    expect(button("Filter by column").textContent).toBe("Columns");
    await act(async () => element<HTMLElement>("[data-board-tag-filter]").click());
    await act(async () =>
      element<HTMLElement>('[data-board-tag-choice="travel"] [role="checkbox"]').click(),
    );
    expect(element("[data-board-tag-filter]").textContent).toBe("#travel");
    await click("Clear chosen tags");
    expect(element("[data-board-tag-filter]").textContent).toBe("Tag");
    expect(button("Board filters")).toBeDefined();
  });
});
