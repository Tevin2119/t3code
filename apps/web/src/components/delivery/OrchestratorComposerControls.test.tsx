import { EnvironmentId } from "@t3tools/contracts";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { flowStartLabel } from "../../lib/delivery";
import { useDeliveryDraftStore, useOrchestratorDraftStore } from "../../state/delivery";

interface TeamsReading {
  body: unknown;
  error: string | null;
}
const testState = vi.hoisted(() => ({
  reading: { body: null, error: null } as TeamsReading,
  engine: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("../../state/delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/delivery")>()),
  useDeliveryRead: () => ({
    ...testState.reading,
    readAt: null,
    isPending: false,
    refresh: () => {},
  }),
  useDeliveryAct: () => testState.engine,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => testState.navigate }));
vi.mock("./OrchestratorPanel", () => ({ useFlowPreview: () => null }));
vi.mock("./SeatSettingsPanel", () => ({ SeatSettingsPanel: () => null }));
vi.mock("./SetupPanel", () => ({ SetupPanel: () => null }));
vi.mock("./TeamDefaultsDialog", () => ({ TeamDefaultsDialog: () => null }));
vi.mock("./InfoPopover", () => ({ InfoPopover: () => null }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "span",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "span",
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: "div",
  PopoverTitle: "div",
  PopoverTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: ({ children }: { children: ReactNode }) => <span data-tooltip>{children}</span>,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, undefined, children),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/spinner", () => ({ Spinner: "span" }));

import {
  OrchestratorComposerControls,
  OrchestratorPrimaryActions,
} from "./OrchestratorComposerControls";

const ENV = EnvironmentId.make("env-a");
const THREAD = "t1";
const team = (name: string) => ({ team: name, purpose: `${name}.`, available: true });
const DEVELOPMENT = team("development");
const RND = team("rnd");
const GONE = "Team rnd is not offered here. Choose another team.";

let renderer: ReactTestRenderer | undefined;
let prompt = "Build it";

function Composer(props: { readonly prompt: string }) {
  return (
    <form>
      <OrchestratorComposerControls
        environmentId={ENV}
        threadId={THREAD}
        prompt={props.prompt}
        onPromptCleared={() => {}}
      />
      <OrchestratorPrimaryActions
        threadId={THREAD}
        promptHasText={props.prompt.trim().length > 0}
      />
    </form>
  );
}

async function render(next: { prompt?: string } = {}) {
  prompt = next.prompt ?? prompt;
  await act(async () => {
    if (renderer) renderer.update(<Composer prompt={prompt} />);
    else renderer = create(<Composer prompt={prompt} />);
  });
}

/** A new list of teams, as a later reading of the environment would bring it. */
async function teamsBecome(body: unknown, error: string | null = null) {
  testState.reading = { body, error };
  await render();
}

const store = () => useOrchestratorDraftStore.getState();
const draft = () => store().drafts[THREAD];
const activity = () => store().activity[THREAD];

const hosts = (matches: (node: ReactTestInstance) => boolean) =>
  renderer!.root.findAll((node) => typeof node.type === "string" && matches(node));
const marked = (marker: string) => hosts((node) => node.props[marker] !== undefined);
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const startButton = () => marked("data-delivery-start-workflow")[0]!;
const saveButton = () => marked("data-delivery-save-draft")[0]!;
const alerts = () => hosts((node) => node.props.role === "alert");
const teamSelect = () => hosts((node) => typeof node.props.onValueChange === "function")[0]!;
const tooltips = () => marked("data-tooltip").map(textOf);
const paths = () => testState.engine.mock.calls.map((call) => call[0]);

async function ask(...kinds: ReadonlyArray<"start" | "save">) {
  for (const kind of kinds) {
    await act(async () => {
      if (kind === "start") store().requestStart(THREAD);
      else store().requestSave(THREAD);
    });
  }
}

async function choose(name: string) {
  await act(async () => store().chooseTeam(THREAD, ENV, name));
}

/** A settled draft for which a person chose team rnd while it was offered. */
async function chosenRnd(kind: "new" | "saved") {
  store().enter(THREAD, ENV);
  await render();
  await choose("rnd");
  if (kind === "saved") {
    await act(async () => store().update(THREAD, { engineThread: "task-1", savedText: "Older" }));
  }
  expect(draft()?.team).toBe("rnd");
  expect(draft()?.awaitingTeams).toBeUndefined();
}

function expectOpen(name: string) {
  expect(alerts()).toEqual([]);
  expect(marked("data-delivery-team-unavailable")).toEqual([]);
  expect(activity()?.teamUnavailable).toBeNull();
  expect(startButton().props.disabled).toBe(false);
  expect(startButton().props["aria-label"]).toBe(`${flowStartLabel("standard")} for team ${name}`);
  expect(saveButton().props.disabled).toBe(false);
}

function expectGone() {
  expect(draft()?.team).toBe("rnd");
  expect(teamSelect().props.value).toBe("rnd");
  expect(alerts()).toHaveLength(1);
  expect(textOf(alerts()[0]!)).toBe(GONE);
  expect(marked("data-delivery-team-unavailable").map(textOf)).toEqual([GONE]);
  expect(activity()?.teamUnavailable).toBe(GONE);
  expect(startButton().props.disabled).toBe(true);
  expect(startButton().props["aria-label"]).toBe(GONE);
  expect(saveButton().props.disabled).toBe(true);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.reading = { body: [DEVELOPMENT, RND, team("triage")], error: null };
  testState.engine.mockReset();
  testState.engine.mockImplementation(async () => ({
    ok: true,
    body: { id: "task-1", card: {} },
  }));
  testState.navigate.mockReset();
  useOrchestratorDraftStore.setState({
    drafts: {},
    saveRequests: {},
    startRequests: {},
    activity: {},
  });
  useDeliveryDraftStore.setState({ choices: {}, inherited: {}, remembered: {} });
  renderer = undefined;
  prompt = "Build it";
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("a team that was offered, chosen, and then left the list", () => {
  it.each(["new", "saved"] as const)(
    "stands on a %s draft, is named as not offered, and nothing is sent",
    async (kind) => {
      await chosenRnd(kind);
      expectOpen("rnd");

      await teamsBecome([DEVELOPMENT]);
      expectGone();
      // The disabled buttons cannot show a tooltip, yet both say why.
      expect(tooltips().filter((item) => item === GONE)).toHaveLength(2);
      expect(hosts((node) => node.type === "p").map(textOf)).toContain(GONE);

      // The send key asks without the button: the request is refused before the engine.
      await ask("start", "save");
      expect(testState.engine).not.toHaveBeenCalled();
      expectGone();

      // The missing team is said ahead of the missing text.
      await render({ prompt: "" });
      await ask("start", "save");
      expect(testState.engine).not.toHaveBeenCalled();
      expectGone();
    },
  );

  it("starts again once an offered team is chosen", async () => {
    await chosenRnd("new");
    await teamsBecome([DEVELOPMENT]);
    await ask("start", "save");
    expectGone();

    await choose("development");
    expect(draft()?.team).toBe("development");
    expectOpen("development");
    // What was refused is not sent later.
    expect(testState.engine).not.toHaveBeenCalled();

    await ask("start");
    expect(paths()).toEqual(["/api/tasks", "/api/tasks/task-1/submit"]);
    expect(testState.engine.mock.calls[0]?.[1]).toMatchObject({
      team: "development",
      text: "Build it",
      draft: true,
    });
    expect(testState.navigate).toHaveBeenCalledTimes(1);
  });

  it("starts again once the team is offered again, without another choice", async () => {
    await chosenRnd("saved");
    await teamsBecome([DEVELOPMENT]);
    await ask("start", "save");
    expectGone();

    await teamsBecome([DEVELOPMENT, RND]);
    expect(draft()?.team).toBe("rnd");
    expectOpen("rnd");
    expect(testState.engine).not.toHaveBeenCalled();

    await ask("start");
    expect(paths()).toEqual(["/api/tasks/task-1/edit", "/api/tasks/task-1/submit"]);
    expect(testState.engine.mock.calls[0]?.[1]).toMatchObject({ team: "rnd", text: "Build it" });
  });

  it("also blocks a remembered team nobody chose here, once it was held against the list", async () => {
    useDeliveryDraftStore.getState().rememberTeam(ENV, "rnd");
    store().enter(THREAD, ENV);
    await render();
    expect(draft()).toMatchObject({ team: "rnd" });
    expect(draft()?.awaitingTeams).toBeUndefined();
    expectOpen("rnd");

    await teamsBecome([DEVELOPMENT]);
    expectGone();
    await ask("start", "save");
    expect(testState.engine).not.toHaveBeenCalled();
    expectGone();
  });
});

describe("what says a team is not offered", () => {
  it("is a list that was read, and an empty one too", async () => {
    await chosenRnd("new");
    await teamsBecome([]);
    expectGone();
    await ask("start", "save");
    expect(testState.engine).not.toHaveBeenCalled();
  });

  it("is not a list still being read", async () => {
    await chosenRnd("new");
    await teamsBecome(null);
    expect(draft()?.team).toBe("rnd");
    expect(alerts()).toEqual([]);
    expect(activity()?.teamUnavailable).toBeNull();
    expect(hosts((node) => node.type === "p").map(textOf)).toContain("Reading the team.");
  });

  it("is not a reading that failed, whatever older list came with it", async () => {
    await chosenRnd("new");
    await teamsBecome([DEVELOPMENT], "No answer.");
    expect(draft()?.team).toBe("rnd");
    expect(alerts()).toEqual([]);
    expect(activity()?.teamUnavailable).toBeNull();
    expect(startButton().props.disabled).toBe(true);
    expect(startButton().props["aria-label"]).toBe("Delivery engine not reachable. No answer.");
    // Saving a settled draft was never held back by a failed reading, and is not now.
    expect(saveButton().props.disabled).toBe(false);
  });

  it("is never said while a remembered team gives way to the default team", async () => {
    const said: Array<string | null | undefined> = [];
    const stop = useOrchestratorDraftStore.subscribe((state) => {
      said.push(state.activity[THREAD]?.teamUnavailable);
    });
    useDeliveryDraftStore.getState().rememberTeam(ENV, "sales");
    testState.reading = { body: null, error: null };
    store().enter(THREAD, ENV);
    await render();
    expect(draft()).toMatchObject({ team: "sales", awaitingTeams: true });
    expect(alerts()).toEqual([]);

    await teamsBecome([DEVELOPMENT, RND]);
    stop();
    expect(draft()?.team).toBe("development");
    expect(said.length).toBeGreaterThan(0);
    expect(said.filter((item) => item != null)).toEqual([]);
    expectOpen("development");
  });
});
