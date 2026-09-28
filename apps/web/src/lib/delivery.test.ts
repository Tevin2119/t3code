import { describe, expect, it } from "vite-plus/test";

import {
  deliveryFailureText,
  describeBinding,
  isStaleReading,
  parseBoard,
  parseOrchestratorThread,
  parseTeams,
  resolveTeamChoice,
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

  it("blocks the send when the team cannot serve this harness", () => {
    expect(
      resolveTeamChoice({ teams, team: "rnd", role: null, driver: "claudeAgent" }),
    ).toMatchObject({ state: "blocked", why: "Team rnd has no seat on this harness." });
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
  });

  it("is null for a thread of another kind", () => {
    expect(parseOrchestratorThread({ kind: "chat", task: {} })).toBeNull();
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
