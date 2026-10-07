import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useDeliveryDraftStore, useOrchestratorDraftStore } from "../../state/delivery";
import { OrchestratorComposerControls } from "./OrchestratorComposerControls";

const mock = vi.hoisted(() => ({
  reading: { body: null as unknown, error: null as string | null },
  action: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mock.navigate }));
vi.mock("../../state/delivery", async (original) => ({
  ...(await original<typeof import("../../state/delivery")>()),
  useDeliveryRead: () => mock.reading,
  useDeliveryAct: () => mock.action,
}));
vi.mock("./OrchestratorPanel", () => ({ useFlowPreview: () => null }));
vi.mock("../ui/select", () => ({
  Select: "select-root",
  SelectTrigger: "select-trigger",
  SelectValue: "output",
  SelectPopup: "select-popup",
  SelectItem: "select-item",
}));
vi.mock("../ui/popover", () => ({
  Popover: "popover-root",
  PopoverTrigger: "popover-trigger",
  PopoverPopup: "popover-popup",
  PopoverTitle: "popover-title",
}));
vi.mock("./InfoPopover", () => ({ InfoPopover: "info-popover" }));
vi.mock("./SeatSettingsPanel", () => ({ SeatSettingsPanel: "seat-settings" }));
vi.mock("./SetupPanel", () => ({ SetupPanel: "setup-panel" }));
vi.mock("./TeamDefaultsDialog", () => ({ TeamDefaultsDialog: "team-defaults" }));
const store = () => useOrchestratorDraftStore.getState();
const offered = (...names: ReadonlyArray<string>) =>
  names.map((team) => ({ team, available: true, seats: [], settings: [] }));
const teams = offered("rnd", "alpha");
let renderer: ReactTestRenderer | undefined;
const prompts = { t1: "Build this", t2: "Fix that" } as const;
type Thread = keyof typeof prompts;
let cleared: Array<Thread> = [];
// The composer keeps one instance across threads and passes a fresh callback on each render.
const view = (threadId: Thread) => (
  <OrchestratorComposerControls
    environmentId={EnvironmentId.make("env-a")}
    threadId={threadId}
    prompt={prompts[threadId]}
    onPromptCleared={() => cleared.push(threadId)}
  />
);
async function render(threadId: Thread = "t1") {
  await act(() => {
    if (renderer) renderer.update(view(threadId));
    else renderer = create(view(threadId));
  });
}
const paths = () => mock.action.mock.calls.map(([path]) => path);
const alert = () =>
  renderer!.root
    .findAllByProps({ role: "alert" })
    .map((node) => node.children.join(""))
    .join(" ");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useDeliveryDraftStore.setState({ choices: {}, inherited: {}, remembered: {} });
  useOrchestratorDraftStore.setState({
    drafts: {},
    activity: {},
    saveRequests: {},
    startRequests: {},
  });
  mock.reading = { body: null, error: null };
  mock.navigate.mockReset();
  cleared = [];
  mock.action
    .mockReset()
    .mockImplementation(async (path: string, body: { team?: string; text?: string }) => {
      // The engine takes a task only for a team it offers at the time.
      const listed = Array.isArray(mock.reading.body) ? (mock.reading.body as typeof teams) : [];
      if (path === "/api/tasks" && !listed.some((team) => team.team === body.team))
        return { ok: false, problems: ["unknown team"] };
      const id = body.text === prompts.t2 ? "task-2" : "task-1";
      return { ok: true, body: { id, card: {} } };
    });
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it.each([null, "gone"])(
  "starts with the first offered team (remembered %s)",
  async (remembered) => {
    if (remembered) useDeliveryDraftStore.getState().rememberTeam("env-a", remembered);
    store().enter("t1", "env-a");
    await render();
    await act(() => store().requestStart("t1"));
    expect(mock.action).not.toHaveBeenCalled();
    expect(store().activity.t1?.blocked).toBe("Teams are still loading.");
    mock.reading = { body: teams, error: null };
    await render();
    expect(mock.action).not.toHaveBeenCalled();
    expect(
      renderer!.root.findByProps({ "aria-label": "Team" }).findByType("output").children,
    ).toEqual(["rnd"]);
    const navigated = new Promise<void>((resolve) =>
      mock.navigate.mockImplementation(() => resolve()),
    );
    await act(async () => {
      store().requestStart("t1");
    });
    await navigated;
    expect(mock.action).toHaveBeenCalledWith(
      "/api/tasks",
      expect.objectContaining({ team: "rnd", draft: true }),
    );
    expect(mock.action).toHaveBeenCalledWith("/api/tasks/task-1/submit", expect.anything());
  },
);

it.each([{ body: [] }, { body: [{ team: "triage", available: true }] }])(
  "blocks empty selectable lists before any press",
  async ({ body }) => {
    store().enter("t1", "env-a");
    await render();
    mock.reading = { body, error: null };
    await render();
    expect(store().drafts.t1?.awaitingTeams).toBe(true);
    expect(alert()).toBe("No teams are available to choose from.");
    expect(store().activity.t1?.blocked).toBe(alert());
    await act(() => {
      store().requestStart("t1");
      store().requestSave("t1");
    });
    expect(mock.action).not.toHaveBeenCalled();
    expect(renderer!.root.findAllByType("p").flatMap((node) => node.children)).not.toContain(
      "Reading the team.",
    );
  },
);

it.each([
  [["rnd", "alpha"], "rnd"],
  [["rnd", "development"], "development"],
] as const)(
  "settles when an empty list becomes %j, without replaying a blocked press",
  async (names, expected) => {
    store().enter("t1", "env-a");
    await render();
    const reasons: Array<string | null | undefined> = [];
    const unsubscribe = useOrchestratorDraftStore.subscribe((state) => {
      reasons.push(state.activity.t1?.blocked, state.activity.t1?.teamAvailabilityReason);
    });
    mock.reading = { body: [], error: null };
    await render();
    await act(() => {
      store().requestStart("t1");
      store().requestSave("t1");
    });
    expect(alert()).toBe("No teams are available to choose from.");
    expect(store().activity.t1).toMatchObject({
      blocked: alert(),
      teamAvailabilityReason: alert(),
      awaitingTeams: true,
    });
    expect(store().drafts.t1?.awaitingTeams).toBe(true);
    expect(mock.action).not.toHaveBeenCalled();

    mock.reading = { body: offered(...names), error: null };
    await render();
    unsubscribe();
    expect(mock.action).not.toHaveBeenCalled();
    expect(store().drafts.t1?.team).toBe(expected);
    expect(store().drafts.t1).not.toHaveProperty("awaitingTeams");
    expect(
      renderer!.root.findByProps({ "aria-label": "Team" }).findByType("output").children,
    ).toEqual([expected]);
    expect(alert()).toBe("");
    expect(store().activity.t1?.blocked).toBeNull();
    expect(reasons.filter((reason) => /is not offered here/.test(reason ?? ""))).toEqual([]);

    const navigated = new Promise<void>((resolve) =>
      mock.navigate.mockImplementation(() => resolve()),
    );
    await act(async () => {
      store().requestStart("t1");
    });
    await navigated;
    expect(mock.action.mock.calls.map(([path]) => path)).toEqual([
      "/api/tasks",
      "/api/tasks/task-1/submit",
    ]);
    expect(mock.action).toHaveBeenCalledWith(
      "/api/tasks",
      expect.objectContaining({ team: expected, draft: true }),
    );
  },
);

it.each([null, "saved-task"])(
  "preserves a missing choice and blocks create or edit (%s)",
  async (engineThread) => {
    store().enter("t1", "env-a");
    store().chooseTeam("t1", "env-a", "missing");
    if (engineThread) store().update("t1", { engineThread });
    await render();
    expect(alert()).toBe("");
    mock.reading = { body: teams, error: null };
    await render();
    await act(() => {
      store().requestStart("t1");
      store().requestSave("t1");
    });
    expect(store().drafts.t1?.team).toBe("missing");
    expect(alert()).toBe("Team missing is not offered here. Choose another team.");
    expect(store().activity.t1?.blocked).toBe(alert());
    expect(mock.action).not.toHaveBeenCalled();
    await act(() => store().chooseTeam("t1", "env-a", "alpha"));
    expect(alert()).toBe("");
  },
);

it("keeps read errors distinct from empty lists", async () => {
  store().enter("t1", "env-a");
  mock.reading = { body: null, error: "offline" };
  await render();
  await act(() => store().requestStart("t1"));
  expect(alert()).toBe("Delivery engine not reachable. offline");
  expect(mock.action).not.toHaveBeenCalled();
});

it("does not skip an ineligible first offered team", async () => {
  store().enter("t1", "env-a");
  mock.reading = {
    body: [{ ...teams[0], available: false, why: "Needs setup" }, teams[1]],
    error: null,
  };
  await render();
  expect(store().drafts.t1?.team).toBe("rnd");
  expect(store().activity.t1?.blocked).toBeTruthy();
  await act(() => store().requestStart("t1"));
  expect(alert()).toBe(store().activity.t1?.blocked);
  expect(mock.action).not.toHaveBeenCalled();
});

// t2 settles with teams read, then t1 is entered while the teams are still read and a
// Start on it is refused. This is the order in which QA saw t2 start by itself.
async function settleT2ThenRefuseStartOnT1() {
  mock.reading = { body: teams, error: null };
  store().enter("t2", "env-a");
  await render("t2");
  expect(store().drafts.t2).toBeDefined();
  expect(store().drafts.t2).not.toHaveProperty("awaitingTeams");
  expect(store().activity.t2?.blocked).toBeNull();
  mock.reading = { body: null, error: null };
  store().enter("t1", "env-a");
  await render("t1");
  expect(store().drafts.t1?.awaitingTeams).toBe(true);
  await act(() => store().requestStart("t1"));
  expect(store().activity.t1?.blocked).toBe("Teams are still loading.");
  expect(mock.action).not.toHaveBeenCalled();
}

// Switches to a thread and renders it again a few times without a new request.
async function switchTo(threadId: Thread) {
  const before = { calls: paths(), navigations: mock.navigate.mock.calls.length, cleared };
  for (let i = 0; i < 3; i++) await render(threadId);
  expect(paths()).toEqual(before.calls);
  expect(mock.navigate).toHaveBeenCalledTimes(before.navigations);
  expect(cleared).toEqual(before.cleared);
}

function navigation() {
  return new Promise<void>((resolve) => mock.navigate.mockImplementation(() => resolve()));
}

it("does not start a thread when switching to it after a refused start elsewhere", async () => {
  await settleT2ThenRefuseStartOnT1();
  await switchTo("t2");
  // Nothing but the switch keeps t2 from starting: it has a prompt and nothing blocks it.
  expect(store().activity.t2?.blocked).toBeNull();
  expect(mock.action).not.toHaveBeenCalled();
  expect(mock.navigate).not.toHaveBeenCalled();
  expect(cleared).toEqual([]);
  expect(store().drafts.t1).toBeDefined();
  expect(store().drafts.t2).toBeDefined();
});

it("never acts on switches alone, and does not replay a refused start", async () => {
  await settleT2ThenRefuseStartOnT1();
  await act(() => {
    store().requestStart("t1");
    store().requestSave("t1");
  });
  expect(mock.action).not.toHaveBeenCalled();
  // With the teams read, t2 could really be saved, submitted and left for the board.
  mock.reading = { body: teams, error: null };
  for (const threadId of ["t2", "t1", "t2", "t1", "t2", "t1"] as const) await switchTo(threadId);
  expect(store().drafts.t1).not.toHaveProperty("awaitingTeams");
  expect(store().activity.t1?.blocked).toBeNull();
  expect(store().activity.t2?.blocked).toBeNull();
  expect(mock.action).not.toHaveBeenCalled();
  expect(store().drafts.t2).toBeDefined();

  const navigated = navigation();
  await act(async () => {
    store().requestStart("t1");
  });
  await navigated;
  expect(paths()).toEqual(["/api/tasks", "/api/tasks/task-1/submit"]);
  expect(mock.action).toHaveBeenCalledWith(
    "/api/tasks",
    expect.objectContaining({ text: prompts.t1, draft: true }),
  );
  expect(mock.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/board",
    search: { task: "task-1" },
  });
  expect(cleared).toEqual(["t1"]);
  expect(store().drafts.t1).toBeUndefined();
  expect(store().drafts.t2).toBeDefined();
});

it("saves only the thread a save was asked on", async () => {
  mock.reading = { body: teams, error: null };
  store().enter("t1", "env-a");
  store().enter("t2", "env-a");
  await render("t2");
  await render("t1");
  await act(async () => {
    store().requestSave("t1");
  });
  expect(paths()).toEqual(["/api/tasks"]);
  expect(store().drafts.t1?.engineThread).toBe("task-1");
  for (const threadId of ["t2", "t1", "t2", "t1", "t2"] as const) await switchTo(threadId);
  expect(paths()).toEqual(["/api/tasks"]);

  await act(async () => {
    store().requestSave("t2");
  });
  expect(paths()).toEqual(["/api/tasks", "/api/tasks"]);
  expect(mock.action).toHaveBeenLastCalledWith(
    "/api/tasks",
    expect.objectContaining({ text: prompts.t2, draft: true }),
  );
  expect(store().drafts.t2).toMatchObject({ engineThread: "task-2", savedText: prompts.t2 });
  await switchTo("t2");
  expect(mock.navigate).not.toHaveBeenCalled();
  expect(cleared).toEqual([]);
  expect(store().drafts.t1).toBeDefined();
});

it("starts a thread switched to once, when Start is asked on it", async () => {
  await settleT2ThenRefuseStartOnT1();
  mock.reading = { body: teams, error: null };
  await switchTo("t2");
  const navigated = navigation();
  await act(async () => {
    store().requestStart("t2");
  });
  await navigated;
  expect(paths()).toEqual(["/api/tasks", "/api/tasks/task-2/submit"]);
  expect(mock.action).toHaveBeenCalledWith(
    "/api/tasks",
    expect.objectContaining({ text: prompts.t2, draft: true }),
  );
  expect(mock.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/board",
    search: { task: "task-2" },
  });
  expect(cleared).toEqual(["t2"]);
  expect(store().drafts.t2).toBeUndefined();
  expect(store().drafts.t1).toBeDefined();
  await switchTo("t2");
  // The refused start on t1 stays refused when t1 is shown again.
  await switchTo("t1");
  expect(paths()).toEqual(["/api/tasks", "/api/tasks/task-2/submit"]);
});
