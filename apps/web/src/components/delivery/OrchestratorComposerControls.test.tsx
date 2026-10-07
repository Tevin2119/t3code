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
const view = () => (
  <OrchestratorComposerControls
    environmentId={EnvironmentId.make("env-a")}
    threadId="t1"
    prompt="Build this"
    onPromptCleared={() => {}}
  />
);
async function render() {
  await act(() => {
    if (renderer) renderer.update(view());
    else renderer = create(view());
  });
}
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
  mock.action.mockReset().mockImplementation(async (path: string, body: { team?: string }) => {
    // The engine takes a task only for a team it offers at the time.
    const listed = Array.isArray(mock.reading.body) ? (mock.reading.body as typeof teams) : [];
    if (path === "/api/tasks" && !listed.some((team) => team.team === body.team))
      return { ok: false, problems: ["unknown team"] };
    return { ok: true, body: { id: "task-1", card: {} } };
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

it.each([
  { engineThread: null, removeFirst: false },
  { engineThread: null, removeFirst: true },
  { engineThread: "saved-task", removeFirst: false },
  { engineThread: "saved-task", removeFirst: true },
])(
  "keeps a missing choice blocked after failure ($engineThread, removed first: $removeFirst)",
  async ({ engineThread, removeFirst }) => {
    store().enter("t1", "env-a");
    mock.reading = { body: teams, error: null };
    await render();
    await act(() => {
      store().chooseTeam("t1", "env-a", "rnd");
      if (engineThread) store().update("t1", { engineThread, savedText: "Earlier prompt" });
    });
    const reason = "Team rnd is not offered here. Choose another team.";
    if (removeFirst) {
      mock.reading = { body: offered("alpha"), error: null };
      await render();
      expect(alert()).toBe(reason);
    }
    mock.reading = { body: offered("alpha"), error: "offline" };
    await render();
    expect(alert()).toBe(reason);
    expect(store().activity.t1).toMatchObject({
      teamAvailabilityReason: reason,
      blocked: "Delivery engine not reachable. offline",
    });
    await act(() => {
      store().requestSave("t1");
      store().requestStart("t1");
    });
    expect(mock.action).not.toHaveBeenCalled();
    expect(alert()).toBe(reason);

    mock.reading = { body: teams, error: null };
    await render();
    expect(alert()).toBe("");
    expect(store().activity.t1?.teamAvailabilityReason).toBeNull();
    expect(mock.action).not.toHaveBeenCalled();
    await act(async () => store().requestSave("t1"));
    expect(mock.action).toHaveBeenCalledTimes(1);
    expect(mock.action).toHaveBeenCalledWith(
      engineThread ? `/api/tasks/${engineThread}/edit` : "/api/tasks",
      expect.objectContaining({ team: "rnd" }),
    );
  },
);

it.each([null, "saved-task"])(
  "distinguishes successful empty from failed retained empty for a settled draft (%s)",
  async (engineThread) => {
    store().enter("t1", "env-a");
    store().chooseTeam("t1", "env-a", "rnd");
    if (engineThread) store().update("t1", { engineThread });
    mock.reading = { body: [], error: null };
    await render();
    expect(alert()).toBe("No teams are available to choose from.");
    expect(store().activity.t1?.teamAvailabilityReason).toBe(alert());
    mock.reading = { body: [], error: "offline" };
    await render();
    expect(alert()).toBe("Team rnd is not offered here. Choose another team.");
    expect(store().activity.t1?.teamAvailabilityReason).toBe(alert());
    expect(store().activity.t1?.blocked).toBe("Delivery engine not reachable. offline");
    await act(() => {
      store().requestSave("t1");
      store().requestStart("t1");
    });
    expect(mock.action).not.toHaveBeenCalled();
  },
);

it.each([
  { name: "settled offered choice", body: offered("rnd"), awaitingTeams: false },
  { name: "settled choice without a body", body: null, awaitingTeams: false },
  { name: "awaiting choice without a body", body: null, awaitingTeams: true },
  {
    name: "awaiting choice missing from retained list",
    body: offered("alpha"),
    awaitingTeams: true,
  },
])("preserves Save behavior on failure for $name", async ({ body, awaitingTeams }) => {
  store().enter("t1", "env-a");
  if (!awaitingTeams) store().chooseTeam("t1", "env-a", "rnd");
  const originalTeam = store().drafts.t1?.team;
  mock.reading = { body, error: "offline" };
  await render();
  expect(alert()).toBe("");
  expect(store().activity.t1?.teamAvailabilityReason).toBeNull();
  expect(store().activity.t1?.blocked).toBe("Delivery engine not reachable. offline");
  expect(store().drafts.t1?.team).toBe(originalTeam);
  expect(store().drafts.t1?.awaitingTeams === true).toBe(awaitingTeams);
  await act(() => store().requestStart("t1"));
  expect(mock.action).not.toHaveBeenCalled();
  await act(async () => store().requestSave("t1"));
  if (awaitingTeams) {
    expect(mock.action).not.toHaveBeenCalled();
  } else {
    expect(mock.action).toHaveBeenCalledTimes(1);
    expect(mock.action).toHaveBeenCalledWith(
      "/api/tasks",
      expect.objectContaining({ team: "rnd", draft: true }),
    );
  }
});

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
