import { EnvironmentId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SeatForThread } from "../../lib/deliverySeats";
import {
  SEAT_TAKEOVER_OVER,
  readDraftTeamChoice,
  useDeliveryDraftStore,
  useDraftTeamChoice,
  useOrchestratorDraftStore,
} from "../../state/delivery";
import { useDraftTeamPicker } from "./useDraftTeamPicker";

interface TeamsReading {
  body: unknown;
  error: string | null;
}
const testState = vi.hoisted(() => ({
  readings: {} as Record<string, TeamsReading>,
}));
const NOT_READ: TeamsReading = { body: null, error: null };
vi.mock("../../state/delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/delivery")>()),
  useDeliveryEnabled: () => true,
  useDeliveryRead: (environmentId: string | null) => ({
    ...(environmentId ? (testState.readings[environmentId] ?? NOT_READ) : NOT_READ),
    readAt: null,
    isPending: false,
    refresh: () => {},
  }),
}));

const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");

const seat = (name: string, role: string, harness: string) => ({
  seat: name,
  role,
  harness,
  model: `${harness}-model`,
  available: true,
  why: null,
});
const setting = (name: string, role: string, harness: string) => ({
  seat: name,
  role,
  harness,
  now: { model: `${harness}-model`, reasoning: null, access: "full" },
  may: { model: true, reasoning: [], access: ["full"] },
  why: { model: null, reasoning: null, access: null },
});
const TEAMS = [
  {
    team: "development",
    purpose: "Build.",
    available: true,
    seats: [seat("developer", "lead-developer", "claude"), seat("lead", "team-lead", "codex")],
    settings: [
      setting("developer", "lead-developer", "claude"),
      setting("lead", "team-lead", "codex"),
    ],
  },
  {
    team: "rnd",
    purpose: "Research.",
    available: true,
    seats: [seat("scout", "scout", "kimi"), seat("challenger", "challenger", "kimi")],
    settings: [setting("scout", "scout", "kimi"), setting("challenger", "challenger", "kimi")],
  },
  { team: "triage", purpose: "Sorts.", available: true, seats: [] },
];

type Picker = ReturnType<typeof useDraftTeamPicker>;
interface ProbeProps {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: string;
  readonly driver: string | null;
}

let renderer: ReactTestRenderer | undefined;
let latest: Picker;
let stored: Array<ReturnType<typeof useDraftTeamChoice>> = [];
let taken: Array<{ seat: SeatForThread; how: string }> = [];
const onSeat = (taken_: SeatForThread, how: string) => {
  taken.push({ seat: taken_, how });
};

function Probe(props: ProbeProps) {
  const picker = useDraftTeamPicker({ ...props, onSeat });
  const choice = useDraftTeamChoice(props.threadId, props.environmentId);
  useLayoutEffect(() => {
    latest = picker;
    stored.push(choice);
  });
  return null;
}

let shown: ProbeProps;
async function render(props: Partial<ProbeProps> = {}) {
  shown = { environmentId: ENV_A, threadId: "t1", driver: "claudeAgent", ...shown, ...props };
  await act(() => {
    if (renderer) renderer.update(<Probe {...shown} />);
    else renderer = create(<Probe {...shown} />);
  });
}

const drafts = () => useDeliveryDraftStore.getState();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.readings = { "env-a": { body: TEAMS, error: null } };
  useDeliveryDraftStore.setState({ choices: {}, inherited: {}, remembered: {} });
  useOrchestratorDraftStore.setState({ drafts: {} });
  renderer = undefined;
  shown = { environmentId: ENV_A, threadId: "t1", driver: "claudeAgent" };
  stored = [];
  taken = [];
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("the team a new thread's picker shows", () => {
  it("is No team with nothing remembered, where Orchestrator mode starts from development", async () => {
    await render();
    expect(latest.choice).toEqual({ team: null, role: null });
    expect(latest.resolved).toEqual({ state: "manual" });
    expect(latest.warning).toBeNull();
    expect(taken).toEqual([]);
    // No team is always there to choose, among the teams without triage.
    expect(latest.teams.map((team) => team.team)).toEqual(["development", "rnd"]);

    useOrchestratorDraftStore.getState().enter("t1", ENV_A);
    expect(useOrchestratorDraftStore.getState().drafts.t1?.team).toBe("development");
  });

  it("is the team last chosen on the environment, and not on another", async () => {
    await render();
    await act(() => latest.setTeam("development"));
    expect(latest.choice.team).toBe("development");
    expect(readDraftTeamChoice("t1", ENV_A)).toEqual({ team: "development", role: null });

    await render({ threadId: "t2" });
    expect(latest.choice).toEqual({ team: "development", role: null });
    expect(latest.resolved).toEqual({
      state: "ready",
      team: "development",
      role: "lead-developer",
    });

    testState.readings["env-b"] = { body: TEAMS, error: null };
    await render({ threadId: "t3", environmentId: ENV_B });
    expect(latest.choice.team).toBeNull();
    await render({ threadId: "t3", environmentId: null });
    expect(latest.choice.team).toBeNull();

    // No team chosen on the environment is what the next thread there starts with.
    await render({ threadId: "t2", environmentId: ENV_A });
    await act(() => latest.setTeam(null));
    await render({ threadId: "t4" });
    expect(latest.choice.team).toBeNull();
    expect(drafts().remembered).toEqual({ "env-a": null });
  });

  it("hands on the same stored choice while nothing changes", async () => {
    drafts().rememberTeam(ENV_A, "development");
    await render();
    await render();
    await render();
    expect(stored.length).toBeGreaterThanOrEqual(3);
    expect(new Set(stored).size).toBe(1);
    expect(stored[0]).toEqual({ team: "development", role: null });
  });

  it("says nothing is wrong while the teams are read, and shows No team once the team is known gone", async () => {
    drafts().rememberTeam(ENV_A, "sales");
    testState.readings = {};
    await render();
    expect(latest.choice.team).toBe("sales");
    expect(latest.loading).toBe(true);
    expect(latest.warning).toBeNull();

    testState.readings = { "env-a": { body: TEAMS, error: null } };
    await render();
    expect(latest.choice).toEqual({ team: null, role: null });
    expect(latest.resolved).toEqual({ state: "manual" });
    expect(latest.loading).toBe(false);
    expect(latest.warning).toBeNull();
    expect(taken).toEqual([]);
    // What is remembered is not rewritten by showing it.
    expect(drafts().remembered).toEqual({ "env-a": "sales" });
  });

  it("keeps a remembered team and says why when the engine cannot be reached", async () => {
    drafts().rememberTeam(ENV_A, "development");
    testState.readings = { "env-a": { body: null, error: "No answer." } };
    await render();
    expect(latest.choice.team).toBe("development");
    expect(latest.warning).toEqual({
      short: "Engine not reachable",
      detail: "Delivery engine not reachable. No answer.",
    });
  });

  it("says a team the person chose is not set up, with the way out", async () => {
    drafts().chooseTeam("t1", ENV_A, { team: "sales", role: null });
    await render();
    expect(latest.choice.team).toBe("sales");
    expect(latest.warning).toEqual({
      short: "Team not set up",
      detail: "This team is not set up. Choose another team, or No team.",
    });
  });

  it("says so when the harness has no seat in the remembered team", async () => {
    drafts().rememberTeam(ENV_A, "development");
    await render({ driver: "cursor" });
    expect(latest.resolved.state).toBe("blocked");
    expect(latest.offered).toBeNull();
    expect(latest.warning).toEqual({
      short: "No seat for this harness",
      detail: "Teams are not set up for this harness. Choose another harness, or No team.",
    });

    // A harness teams know, with no seat of its own here: a role can be chosen.
    await render({ driver: "kimi" });
    expect(latest.resolved).toMatchObject({ state: "choose-role", team: "development" });
    expect(latest.offered?.roles.map((role) => role.role)).toEqual(["lead-developer", "team-lead"]);
    expect(latest.warning?.short).toBe("No seat for this harness");
    expect(latest.warning?.detail).toContain("or No team");
    expect(taken).toEqual([]);

    await act(() => latest.setRole("team-lead"));
    expect(latest.resolved).toEqual({ state: "ready", team: "development", role: "team-lead" });
    expect(latest.warning).toBeNull();
    expect(drafts().remembered).toEqual({ "env-a": "development" });

    // Several seats of its own: a role is asked for, and no seat is missing.
    await act(() => latest.setTeam("rnd"));
    expect(latest.resolved.state).toBe("choose-role");
    expect(latest.warning).toBeNull();
  });
});

describe("taking over what a seat runs on", () => {
  it("takes a seat over once, and leaves what the person chose after that", async () => {
    drafts().rememberTeam(ENV_A, "development");
    await render();
    expect(taken).toEqual([
      {
        seat: {
          seat: "developer",
          harness: "claude",
          model: "claude-model",
          reasoning: null,
          access: "full",
        },
        how: "inherit",
      },
    ]);
    // The person picks another model: nothing is taken over again on a rerender.
    await render();
    await render();
    expect(taken).toHaveLength(1);

    // Another seat is taken over, once too.
    await act(() => latest.setRole("team-lead"));
    await render();
    expect(taken).toHaveLength(2);
    expect(taken[1]?.seat.seat).toBeNull();
  });

  it("takes nothing over for No team", async () => {
    await render();
    await act(() => latest.setTeam(null));
    await render();
    expect(taken).toEqual([]);
    expect(drafts().inherited).toEqual({});
  });

  it("takes nothing over once the thread was sent, whatever the picker then shows", async () => {
    await render();
    await act(() => latest.setTeam("development"));
    expect(taken).toHaveLength(1);

    // The send clears the choice while the picker is still there: it shows the remembered team.
    await act(() => drafts().clearChoice("t1"));
    await render({ driver: "codex" });
    expect(latest.choice.team).toBe("development");
    expect(latest.threadSeat?.harness).toBe("codex");
    expect(latest.takeoverOver).toBe(true);
    expect(taken).toHaveLength(1);
    expect(drafts().inherited.t1).toBe(SEAT_TAKEOVER_OVER);
  });

  it("takes nothing over for a No team thread that was sent, with a team remembered since", async () => {
    await render();
    await act(() => latest.setTeam(null));
    // Another thread makes development the remembered team.
    await act(() => drafts().chooseTeam("t2", ENV_A, { team: "development", role: null }));
    expect(latest.choice.team).toBeNull();
    await act(() => drafts().clearChoice("t1"));
    await render();
    expect(latest.choice.team).toBe("development");
    expect(taken).toEqual([]);
  });

  it("follows the remembered team on a thread that made no choice of its own", async () => {
    await render();
    expect(latest.choice.team).toBeNull();
    await act(() => drafts().chooseTeam("t2", ENV_A, { team: "development", role: null }));
    expect(latest.choice.team).toBe("development");
    expect(taken).toHaveLength(1);
    expect(taken[0]?.how).toBe("inherit");
  });
});
