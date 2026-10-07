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
  promptCleared: vi.fn(),
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
let environment: string | null = "env-a";
const prompts: Record<string, string> = { t1: "Build this", t2: "Fix that" };
let cleared: Array<string> = [];
// The composer keeps one instance across threads and passes a fresh callback on each render.
const view = (threadId = "t1", prompt = prompts[threadId] ?? "Build this") => (
  <OrchestratorComposerControls
    environmentId={environment === null ? null : EnvironmentId.make(environment)}
    threadId={threadId}
    prompt={prompt}
    onPromptCleared={() => {
      cleared.push(threadId);
      mock.promptCleared();
    }}
  />
);
async function render(threadId = "t1", prompt?: string) {
  await act(() => {
    if (renderer) renderer.update(view(threadId, prompt));
    else renderer = create(view(threadId, prompt));
  });
}
const paths = () => mock.action.mock.calls.map(([path]) => path);
const alert = () =>
  renderer!.root
    .findAllByProps({ role: "alert" })
    .map((node) => node.children.join(""))
    .join(" ");
const LOADING = "Teams are still loading.";
const chosenTeam = () =>
  renderer!.root.findByProps({ "aria-label": "Team" }).findByType("output").children;
/** Asks once, and resolves when the work that followed has ended. */
async function ask(request: "requestStart" | "requestSave") {
  const ended = new Promise<void>((resolve) => {
    let began = false;
    const unsubscribe = useOrchestratorDraftStore.subscribe((state) => {
      if (state.activity.t1?.busy) began = true;
      else if (began) {
        unsubscribe();
        resolve();
      }
    });
  });
  await act(async () => {
    store()[request]("t1");
  });
  await ended;
  await render();
}
/** Enters, asks while the teams are still being read, and checks nothing went to the engine. */
async function askWhilePending(request: "requestStart" | "requestSave") {
  store().enter("t1", "env-a");
  await render();
  await act(() => store()[request]("t1"));
  expect(alert()).toBe(LOADING);
  expect(store().drafts.t1?.awaitingTeams).toBe(true);
  expect(mock.action).not.toHaveBeenCalled();
}
async function startsForRnd() {
  const navigated = new Promise<void>((resolve) =>
    mock.navigate.mockImplementation(() => resolve()),
  );
  await act(async () => {
    store().requestStart("t1");
  });
  await navigated;
  expect(paths()).toEqual(["/api/tasks", "/api/tasks/task-1/submit"]);
  expect(mock.action).toHaveBeenCalledWith(
    "/api/tasks",
    expect.objectContaining({ team: "rnd", draft: true, text: "Build this" }),
  );
  expect(mock.navigate).toHaveBeenCalledWith({ to: "/board", search: { task: "task-1" } });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  environment = "env-a";
  useDeliveryDraftStore.setState({ choices: {}, inherited: {}, remembered: {} });
  useOrchestratorDraftStore.setState({
    drafts: {},
    activity: {},
    saveRequests: {},
    startRequests: {},
  });
  mock.reading = { body: null, error: null };
  mock.navigate.mockReset();
  mock.promptCleared.mockReset();
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

const ineligibleFirst = [
  { team: "rnd", available: false, why: "Needs setup" },
  { team: "alpha", available: true },
];
const expectNoWork = () => {
  expect(mock.action).not.toHaveBeenCalled();
  expect(mock.navigate).not.toHaveBeenCalled();
  expect(mock.promptCleared).not.toHaveBeenCalled();
};

it("attack: pending press, then teams load with an ineligible first team", async () => {
  await askWhilePending("requestStart");
  mock.reading = { body: ineligibleFirst, error: null };
  await render();
  expect(chosenTeam()).toEqual(["rnd"]);
  expect(alert()).toBe("Needs setup");
  expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(1);
  expect(store().activity.t1?.blocked).toBe("Needs setup");
  expectNoWork();

  await act(() => store().chooseTeam("t1", "env-a", "alpha"));
  expect(alert()).toBe("");
  // A pending press follows the live block; report() on a settled press instead
  // preserves that press's message until the next attempt.
  await render("t1", "");
  expect(alert()).toBe("Write what the team is asked to do.");
  await render();
  expect(alert()).toBe("");
  await act(() => store().chooseTeam("t1", "env-a", "rnd"));
  expect(alert()).toBe("Needs setup");
  expectNoWork();

  await act(() => store().requestStart("t1"));
  expect(alert()).toBe("Needs setup");
  expect(store().activity.t1?.blocked).toBe("Needs setup");
  expectNoWork();
});

it.each([false, true])(
  "does not show a settled Start reason after pending Save (Start first: %s)",
  async (startFirst) => {
    await askWhilePending(startFirst ? "requestStart" : "requestSave");
    if (startFirst) await act(() => store().requestSave("t1"));
    expect(alert()).toBe(LOADING);
    mock.reading = { body: ineligibleFirst, error: null };
    await render();
    expect(chosenTeam()).toEqual(["rnd"]);
    expect(store().activity.t1?.blocked).toBe("Needs setup");
    expect(alert()).toBe("");
    expectNoWork();
  },
);

it.each(["before", "after"])(
  "keeps a pending Start's feedback on its own thread when switching %s settlement",
  async (when) => {
    await askWhilePending("requestStart");
    if (when === "after") {
      mock.reading = { body: ineligibleFirst, error: null };
      await render();
      expect(alert()).toBe("Needs setup");
    }
    await act(() => {
      store().enter("t2", "env-a");
      // Equal counters prevent the request effects from treating the switch as a press.
      useOrchestratorDraftStore.setState({
        startRequests: { t1: 1, t2: 1 },
        saveRequests: { t1: 0, t2: 0 },
      });
    });
    await render("t2");
    expect(alert()).toBe("");
    mock.reading = { body: ineligibleFirst, error: null };
    await render("t2");
    expect(store().activity.t2?.blocked).toBe("Needs setup");
    expect(alert()).toBe("");
    expectNoWork();
    // Returning to the requesting thread restores its still-current pending feedback.
    await render("t1");
    expect(alert()).toBe("Needs setup");
    expectNoWork();
  },
);

const requests = ["requestStart", "requestSave"] as const;

it.each(requests)("drops the loading notice of a pending %s once teams load", async (request) => {
  await askWhilePending(request);
  mock.reading = { body: teams, error: null };
  await render();
  expect(chosenTeam()).toEqual(["rnd"]);
  expect(alert()).toBe("");
  expect(store().activity.t1?.blocked).toBeNull();
  expect(store().drafts.t1).not.toHaveProperty("awaitingTeams");
  // A later reading of the same teams does not bring the notice back.
  mock.reading = { body: offered("rnd", "alpha"), error: null };
  await render();
  expect(alert()).toBe("");
  expectNoWork();
  await startsForRnd();
});

it.each(requests)(
  "gives the loading notice of a pending %s up to an empty list, then to nothing",
  async (request) => {
    await askWhilePending(request);
    const alerts = () => renderer!.root.findAllByProps({ role: "alert" }).length;
    expect(alerts()).toBe(1);
    mock.reading = { body: [], error: null };
    await render();
    expect(alerts()).toBe(1);
    expect(alert()).toBe("No teams are available to choose from.");
    expect(store().drafts.t1?.awaitingTeams).toBe(true);
    mock.reading = { body: teams, error: null };
    await render();
    expect(alert()).toBe("");
    expect(store().drafts.t1).not.toHaveProperty("awaitingTeams");
    expect(mock.action).not.toHaveBeenCalled();
    await startsForRnd();
  },
);

it.each(requests)(
  "drops the loading notice of a pending %s under a read error",
  async (request) => {
    await askWhilePending(request);
    mock.reading = { body: null, error: "offline" };
    await render();
    expect(alert()).toBe("");
    expect(store().activity.t1?.blocked).toBe("Delivery engine not reachable. offline");
    // The request was refused for loading, and it is loading again: the notice is true once more.
    mock.reading = { body: null, error: null };
    await render();
    expect(alert()).toBe(LOADING);
    expect(mock.action).not.toHaveBeenCalled();
  },
);

it("puts a missing environment and a read error before loading on Start", async () => {
  store().enter("t1", "env-a");
  environment = null;
  await render();
  await act(() => store().requestStart("t1"));
  expect(alert()).toBe("No environment is connected.");
  environment = "env-a";
  mock.reading = { body: null, error: "offline" };
  await render();
  await act(() => store().requestStart("t1"));
  expect(alert()).toBe("Delivery engine not reachable. offline");
  mock.reading = { body: null, error: null };
  await render();
  await act(() => store().requestStart("t1"));
  expect(alert()).toBe(LOADING);
  expect(mock.action).not.toHaveBeenCalled();
});

it.each([
  ["requestSave", "/api/tasks"],
  ["requestStart", "/api/tasks/task-1/submit"],
] as const)(
  "keeps what the engine said to %s until the next attempt, whatever the teams do",
  async (request, failing) => {
    store().enter("t1", "env-a");
    mock.reading = { body: teams, error: null };
    await render();
    expect(store().drafts.t1).not.toHaveProperty("awaitingTeams");
    // The engine's own words, even these, are not the composer's loading notice.
    mock.action.mockImplementation(async (path: string) =>
      path === failing
        ? { ok: false, problems: [LOADING] }
        : { ok: true, body: { id: "task-1", card: {} } },
    );
    await ask(request);
    expect(alert()).toBe(LOADING);
    const asked = mock.action.mock.calls.length;

    mock.reading = { body: null, error: null };
    await render();
    expect(alert()).toBe(LOADING);
    mock.reading = { body: offered("rnd", "alpha"), error: null };
    await render();
    expect(alert()).toBe(LOADING);
    expect(mock.action).toHaveBeenCalledTimes(asked);
    expect(mock.navigate).not.toHaveBeenCalled();

    mock.action.mockImplementation(async () => ({ ok: true, body: { id: "task-1", card: {} } }));
    await ask("requestSave");
    expect(alert()).toBe("");
    expect(paths().at(-1)).toBe(
      request === "requestSave" ? "/api/tasks" : "/api/tasks/task-1/edit",
    );
  },
);

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
async function switchTo(threadId: string) {
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
