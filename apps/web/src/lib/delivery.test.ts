import { describe, expect, it } from "vite-plus/test";

import {
  decideTeamForSend,
  deliveryFailureText,
  describeBinding,
  isStaleReading,
  parseBoard,
  parseOrchestratorThread,
  parseTeamProfile,
  parseTeams,
  resolveTeamChoice,
  rolesForHarness,
  seatSettingsToSend,
} from "./delivery";

const seat = (overrides: Record<string, unknown>) => ({
  seat: "developer",
  role: "lead-developer",
  harness: "claude",
  model: "claude-fable-5-1",
  provider: "anthropic",
  required: true,
  available: true,
  why: null,
  tools: ["delivery"],
  ...overrides,
});
const teams = parseTeams([
  {
    team: "development",
    purpose: "Build.",
    configuration: "development@2#abc",
    available: true,
    why: null,
    seats: [
      seat({}),
      seat({ seat: "lead", role: "team-lead", harness: "codex" }),
      seat({
        seat: "support",
        role: "maintainer",
        harness: "hermes",
        available: false,
        why: "hermes is not installed or not on the path",
      }),
    ],
    specialists: ["backend"],
    roles: [
      {
        role: "lead-developer",
        title: "Lead developer",
        summary: "Builds.",
        harnesses: ["claude"],
      },
      { role: "maintainer", title: "Maintainer", summary: "Keeps.", harnesses: ["hermes"] },
      { role: "qa-attack", title: "QA, attacking", summary: "Breaks.", harnesses: ["opencode"] },
      { role: "team-lead", title: "Team lead", summary: "Leads.", harnesses: ["codex"] },
    ],
    settings: [
      {
        seat: "developer",
        harness: "claude",
        now: { model: "claude-fable-5-1", reasoning: null, access: "full" },
        may: { model: true, reasoning: ["low", "high"], access: ["full", "read-only"] },
        why: { model: null, reasoning: null, access: null },
      },
      {
        seat: "support",
        harness: "hermes",
        now: { model: null, reasoning: null, access: "full" },
        may: { model: false, reasoning: [], access: ["full"] },
        why: { model: "set in hermes itself", reasoning: "none", access: "full only" },
      },
    ],
    workflows: [
      {
        id: "standard",
        title: "Standard flow",
        stages: ["triage", "plan"],
        stop: "a person decides",
      },
    ],
  },
  {
    team: "rnd",
    purpose: "Research.",
    configuration: "rnd@2#def",
    available: true,
    seats: [
      seat({ seat: "challenger", role: "challenger", harness: "kimi" }),
      seat({ seat: "scout", role: "scout", harness: "kimi" }),
    ],
  },
  { purpose: "no name, so it is dropped" },
  "not a team",
]);

describe("resolveTeamChoice", () => {
  it("is manual when no team is chosen", () => {
    expect(resolveTeamChoice({ teams, team: null, role: null, driver: "claudeAgent" })).toEqual({
      state: "manual",
    });
  });

  it("finds the one role a harness has in a team", () => {
    expect(
      resolveTeamChoice({ teams, team: "development", role: null, driver: "claudeAgent" }),
    ).toEqual({ state: "ready", team: "development", role: "lead-developer" });
    expect(resolveTeamChoice({ teams, team: "development", role: null, driver: "codex" })).toEqual({
      state: "ready",
      team: "development",
      role: "team-lead",
    });
  });

  it("asks for a role when the harness can take several, and takes a valid one", () => {
    expect(resolveTeamChoice({ teams, team: "rnd", role: null, driver: "kimi" })).toEqual({
      state: "choose-role",
      team: "rnd",
      roles: ["challenger", "scout"],
    });
    expect(resolveTeamChoice({ teams, team: "rnd", role: "scout", driver: "kimi" })).toEqual({
      state: "ready",
      team: "rnd",
      role: "scout",
    });
    // A role left over from another team is not taken for a choice.
    expect(
      resolveTeamChoice({ teams, team: "rnd", role: "lead-developer", driver: "kimi" }).state,
    ).toBe("choose-role");
  });

  it("lets any role of the team be chosen, with the harness's own role first", () => {
    const development = teams.find((team) => team.team === "development")!;
    expect(rolesForHarness(development, "claude")).toMatchObject({
      held: "lead-developer",
      roles: [
        { role: "lead-developer" },
        { role: "maintainer" },
        { role: "qa-attack" },
        { role: "team-lead" },
      ],
    });
    expect(
      resolveTeamChoice({ teams, team: "development", role: "qa-attack", driver: "claudeAgent" }),
    ).toEqual({ state: "ready", team: "development", role: "qa-attack" });
    // A harness with no seat in the team can still take a role, once one is chosen.
    expect(resolveTeamChoice({ teams, team: "rnd", role: null, driver: "claudeAgent" })).toEqual({
      state: "choose-role",
      team: "rnd",
      roles: ["challenger", "scout"],
    });
    expect(resolveTeamChoice({ teams, team: "rnd", role: "scout", driver: "claudeAgent" })).toEqual(
      { state: "ready", team: "rnd", role: "scout" },
    );
  });

  it("blocks the send when the team cannot serve this harness", () => {
    expect(
      resolveTeamChoice({ teams, team: "development", role: null, driver: "cursor" }),
    ).toMatchObject({ state: "blocked" });
    expect(resolveTeamChoice({ teams, team: "development", role: null, driver: "hermes" })).toEqual(
      {
        state: "blocked",
        team: "development",
        why: "hermes is not installed or not on the path",
      },
    );
    expect(
      resolveTeamChoice({ teams, team: "sales", role: null, driver: "claudeAgent" }),
    ).toMatchObject({ state: "blocked", why: "This team is not set up." });
  });
});

describe("describeBinding", () => {
  it("never labels an unbound thread as a team's", () => {
    expect(describeBinding(null)).toMatchObject({ label: "Manual / legacy", managed: false });
    expect(describeBinding(undefined).managed).toBe(false);
  });

  it("shows the team, the role and the setup the thread started with", () => {
    const described = describeBinding({
      threadId: "thread-1" as never,
      session: "session-1" as never,
      team: "rnd" as never,
      role: "researcher" as never,
      seat: "researcher" as never,
      harness: "claude" as never,
      driver: "claudeAgent" as never,
      workspace: "C:/work" as never,
      configuration: "rnd@2#def" as never,
      requestedModel: null,
      memoryScope: "team:rnd" as never,
      tools: ["delivery"],
      project: "C:/work",
      boundAt: "2026-09-28T10:00:00.000Z",
    });
    expect(described.label).toBe("rnd · researcher");
    expect(described.detail).toContain("rnd@2#def");
    expect(described.managed).toBe(true);
  });
});

describe("parseBoard", () => {
  it("reads lanes and cards and drops what it cannot read", () => {
    const board = parseBoard({
      view: "development",
      views: [{ id: "development", title: "Development" }],
      lanes: [
        {
          lane: "validation",
          title: "Validation",
          cards: [
            {
              id: "task-1",
              title: "Add a file",
              team: "development",
              lane: "validation",
              state: "doing",
              revision: 2,
              origin: "person",
              parts: [{ id: "task-2", title: "Part", lane: "human-review" }],
              run: {
                id: "run-1",
                state: "running",
                stage: "qa",
                candidate: "abc",
                configuration: "c",
              },
              paused: null,
              findings: { open: 1, all: 3 },
              approvals: [{ actor: "Sam", decision: "approve", stands: false }],
              actions: ["stop", 7],
            },
            "not a card",
          ],
        },
      ],
      notices: [{ key: "seat:x", kind: "credit", text: "Out of credit.", count: 2 }],
      note: null,
    });
    expect(board?.lanes[0]?.cards).toHaveLength(1);
    const card = board?.lanes[0]?.cards[0];
    expect(card?.findings).toEqual({ open: 1, all: 3 });
    expect(card?.actions).toEqual(["stop"]);
    expect(card?.approvals[0]?.stands).toBe(false);
    expect(card?.run?.stage).toBe("qa");
    expect(board?.notices[0]?.count).toBe(2);
  });

  it("is null for an answer that is not a board", () => {
    expect(parseBoard({ error: "not found" })).toBeNull();
    expect(parseBoard(null)).toBeNull();
  });
});

describe("parseOrchestratorThread", () => {
  it("keeps a model for each seat and never invents the one a harness used", () => {
    const thread = parseOrchestratorThread({
      kind: "orchestrator",
      thread: "thread-1",
      team: "development",
      title: "Add a file",
      working: true,
      task: { id: "task-1", state: "doing", revision: 1 },
      state: "started",
      workflow: "standard",
      settings: [
        {
          seat: "lead",
          harness: "codex",
          now: { model: "gpt-6-astra", reasoning: null, access: "full" },
          may: { model: true, reasoning: ["low", "high"], access: ["full"] },
          why: {},
          set: { reasoning: "high", model: "" },
          effective: { model: "gpt-6-astra", reasoning: "high", access: "full" },
        },
      ],
      roster: [seat({})],
      children: [{ run: "run-1", state: "running", stage: "qa", whole: false }],
      council: {
        run: "run-1",
        state: "running",
        stage: "qa",
        configuration: "development@2#abc",
        seats: [
          {
            seat: "lead",
            role: "team-lead",
            harness: "codex",
            provider: "openai",
            required: true,
            requestedModel: "gpt-6-astra",
            actualModel: null,
            activity: "queued",
            blockedBy: "global limit",
            attempts: [{}, {}],
          },
        ],
        votes: [{ seat: "qa-third", provider: "deepseek", verdict: "fail", reason: "wrong" }],
        findings: [],
        concurrency: { active: 4, waiting: 1, global: 4 },
      },
      messages: [{ seq: 1, at: "2026-09-28T10:00:00Z", from: "person", text: "Add a file." }],
      pendingFromPerson: 0,
    });
    const lead = thread?.council?.seats[0];
    expect([lead?.requestedModel, lead?.actualModel, lead?.activity, lead?.blockedBy]).toEqual([
      "gpt-6-astra",
      null,
      "queued",
      "global limit",
    ]);
    expect(lead?.attempts).toBe(2);
    expect(thread?.council?.concurrency).toEqual({ active: 4, waiting: 1, global: 4 });
    expect(thread?.state).toBe("started");
    expect(thread?.settings[0]?.set).toEqual({ reasoning: "high" });
    expect(thread?.settings[0]?.effective.reasoning).toBe("high");
  });

  it("reads a draft, which has no task and no run", () => {
    const draft = parseOrchestratorThread({
      kind: "orchestrator",
      thread: "thread-2",
      team: "development",
      title: "Add a file",
      state: "draft",
      draft: { text: "Add a file." },
      task: null,
      workflows: [{ id: "standard", title: "Standard flow", stages: ["triage"], stop: "x" }],
      roster: [],
      messages: [],
    });
    expect([draft?.state, draft?.task, draft?.draft?.text, draft?.council]).toEqual([
      "draft",
      null,
      "Add a file.",
      null,
    ]);
    expect(draft?.workflows[0]?.id).toBe("standard");
  });

  it("is null for a thread of another kind", () => {
    expect(parseOrchestratorThread({ kind: "chat", task: {} })).toBeNull();
  });
});

describe("seatSettingsToSend", () => {
  it("sends only what differs from what the team defines", () => {
    const development = teams.find((team) => team.team === "development")!;
    expect(
      seatSettingsToSend(development.settings, {
        developer: { model: "claude-fable-5-1", reasoning: "high", access: " full " },
        support: { model: "" },
        nobody: { reasoning: "high" },
      }),
    ).toEqual({ developer: { reasoning: "high" } });
    expect(seatSettingsToSend(development.settings, {})).toEqual({});
  });
});

describe("parseTeamProfile", () => {
  it("reads the layers in order, and keeps a layer that has no text", () => {
    const profile = parseTeamProfile({
      team: "development",
      configuration: "development@3#abc",
      role: "qa-attack",
      harness: "claude",
      heldByASeat: false,
      layers: [
        { name: "company", source: "AGENTS.md", text: null },
        { name: "team", source: "teams/development/TEAM.md", text: "Team rules." },
      ],
      tools: [{ server: "delivery", offers: ["task_get"], runsAs: "a program", route: "MCP" }],
      specialists: [{ name: "backend", text: "You know the backend." }],
      gates: { qa: { seats: ["a", "b", "c"], minimumPassingProviders: 2 } },
    });
    expect(profile?.layers.map((layer) => [layer.name, layer.text])).toEqual([
      ["company", null],
      ["team", "Team rules."],
    ]);
    expect(profile?.qaGate).toEqual({ seats: ["a", "b", "c"], minimum: 2 });
    expect(parseTeamProfile({ error: "no team" })).toBeNull();
  });
});

describe("deliveryFailureText", () => {
  it("says when the engine is not reachable, and passes on the engine's own reason", () => {
    expect(
      deliveryFailureText({ _tag: "DeliveryError", reason: "unreachable", detail: "No answer." }),
    ).toBe("Delivery engine not reachable. No answer.");
    expect(
      deliveryFailureText({
        _tag: "DeliveryError",
        reason: "refused",
        detail: "this cannot be approved: the evidence changed",
      }),
    ).toBe("this cannot be approved: the evidence changed");
    expect(deliveryFailureText({ _tag: "DeliveryError", reason: "disabled", detail: "x" })).toBe(
      "Delivery is turned off in settings.",
    );
  });
});

describe("isStaleReading", () => {
  it("marks a reading stale after twenty seconds, and an unreadable time as stale", () => {
    const at = Date.parse("2026-09-28T10:00:00.000Z");
    expect(isStaleReading("2026-09-28T10:00:00.000Z", at + 5_000)).toBe(false);
    expect(isStaleReading("2026-09-28T10:00:00.000Z", at + 21_000)).toBe(true);
    expect(isStaleReading(null, at)).toBe(true);
    expect(isStaleReading("soon", at)).toBe(true);
  });
});

describe("decideTeamForSend", () => {
  const base = {
    enabled: true,
    isServerThread: false,
    bound: false,
    held: null,
    stateError: null,
    draft: { team: "development", role: null },
    draftIsExplicit: false,
    teams,
    teamsError: null,
    driver: "claudeAgent",
  };

  it("binds a new thread to its team before the first turn", () => {
    expect(decideTeamForSend(base)).toEqual({
      action: "bind",
      team: "development",
      role: "lead-developer",
    });
    expect(decideTeamForSend({ ...base, draft: { team: null, role: null } })).toEqual({
      action: "none",
    });
    expect(decideTeamForSend({ ...base, enabled: false })).toEqual({ action: "none" });
  });

  it("leaves a bound thread and an old thread without a team alone", () => {
    expect(decideTeamForSend({ ...base, isServerThread: true, bound: true })).toEqual({
      action: "none",
    });
    expect(decideTeamForSend({ ...base, isServerThread: true })).toEqual({ action: "none" });
  });

  it("sets the team up again when the first send failed, draft or not", () => {
    const held = { team: "rnd", role: "scout" };
    // The thread was never created: still a draft, and the choice is still there.
    expect(decideTeamForSend({ ...base, held, driver: "kimi" })).toEqual({
      action: "bind",
      team: "rnd",
      role: "scout",
    });
    // The thread was created and its turn failed: a server thread, held on the server.
    // The draft's choice is gone by then, and the held one is used.
    expect(
      decideTeamForSend({
        ...base,
        isServerThread: true,
        held,
        draft: { team: "development", role: null },
        driver: "kimi",
      }),
    ).toEqual({ action: "bind", team: "rnd", role: "scout" });
  });

  it("starts a held thread without a team only when the person chose that", () => {
    const held = { team: "rnd", role: null };
    expect(
      decideTeamForSend({
        ...base,
        held,
        draft: { team: null, role: null },
        draftIsExplicit: true,
      }),
    ).toEqual({ action: "release" });
    // A draft store that merely has no entry is not a choice of "No team".
    expect(
      decideTeamForSend({ ...base, held, draft: { team: null, role: null }, driver: "kimi" })
        .action,
    ).toBe("blocked");
    expect(
      decideTeamForSend({
        ...base,
        held: { team: "rnd", role: "scout" },
        draft: { team: null, role: null },
        driver: "kimi",
      }),
    ).toEqual({ action: "bind", team: "rnd", role: "scout" });
  });

  it("stops the send when the team cannot be set up, and never falls back to no team", () => {
    expect(decideTeamForSend({ ...base, teamsError: "No answer." })).toMatchObject({
      action: "blocked",
    });
    expect(decideTeamForSend({ ...base, stateError: "The record is damaged." })).toMatchObject({
      action: "blocked",
    });
    expect(
      decideTeamForSend({ ...base, isServerThread: true, stateError: "The record is damaged." })
        .action,
    ).toBe("blocked");
    expect(decideTeamForSend({ ...base, driver: "cursor" }).action).toBe("blocked");
    expect(
      decideTeamForSend({ ...base, draft: { team: "rnd", role: null }, driver: "kimi" }),
    ).toEqual({ action: "blocked", why: "Choose a role in team rnd: challenger, scout." });
  });
});
