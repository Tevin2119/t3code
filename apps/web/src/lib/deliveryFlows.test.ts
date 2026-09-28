import { describe, expect, it } from "vite-plus/test";

import {
  flowFor,
  flowStartLabel,
  parseFlows,
  parseProfile,
  parseProfiles,
  parseSeatSettings,
  parseSeatSetup,
  parseTask,
  parseTeams,
  seatIsOn,
  seatSettingsToSend,
  teamTaskBlock,
} from "./delivery";

const flow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: { chat: "Team chat", plan: "Plan", review: "Review", standard: "Standard delivery" }[id],
  summary: `What ${id} does.`,
  stages: [id],
  stop: "somewhere",
  builds: id === "standard",
  offered: true,
  ready: true,
  problems: [],
  seats: ["lead"],
  isDefault: false,
  ...overrides,
});

const [development, research, old] = parseTeams([
  {
    team: "development",
    available: true,
    defaultFlow: "standard",
    flows: ["chat", "plan", "review", "standard"].map((id) =>
      flow(id, { isDefault: id === "standard" }),
    ),
  },
  {
    team: "rnd",
    source: "custom",
    available: true,
    defaultFlow: "chat",
    flows: [
      flow("chat", { isDefault: true }),
      flow("plan"),
      flow("review"),
      flow("standard", {
        offered: false,
        ready: false,
        why: "team rnd names no seats to build, review and test",
      }),
    ],
  },
  { team: "from-before", available: true, takesTasks: false, whyNoTasks: "It takes no task." },
]);

describe("flows", () => {
  it("reads the flows of a team, and whether each can run", () => {
    const flows = parseFlows([
      flow("chat"),
      flow("standard", { ready: false, problems: ["lead is switched off", 7], seats: [] }),
      { title: "no id" },
    ]);
    expect(flows.map((item) => [item.id, item.offered, item.ready, item.problems])).toEqual([
      ["chat", true, true, []],
      ["standard", true, false, ["lead is switched off"]],
    ]);
  });

  it("takes the flow a team runs by default when none is chosen or the chosen one is not its own", () => {
    expect(flowFor(development!, null)).toBe("standard");
    expect(flowFor(development!, "plan")).toBe("plan");
    expect(flowFor(research!, null)).toBe("chat");
    // A delivery that was chosen for another team is not carried to a team that has none.
    expect(flowFor(research!, "standard")).toBe("chat");
    expect(flowFor(null, null)).toBe("standard");
  });

  it("says why work cannot be given to a team in a flow it does not have", () => {
    expect(teamTaskBlock(development!, "standard")).toBeNull();
    expect(teamTaskBlock(research!)).toBeNull();
    expect(teamTaskBlock(research!, "plan")).toBeNull();
    expect(teamTaskBlock(research!, "standard")).toBe(
      "Team rnd has no standard delivery. It has: Team chat, Plan, Review.",
    );
    // An engine from before flows says whether a team takes tasks, and is taken at its word.
    expect(teamTaskBlock(old!)).toBe("It takes no task.");
    expect(research!.source).toBe("custom");
  });

  it("names the start by what is started", () => {
    expect(["chat", "plan", "review", "standard", "sprint", null].map(flowStartLabel)).toEqual([
      "Start team chat",
      "Start plan",
      "Start review",
      "Start delivery",
      "Start workflow",
      "Start workflow",
    ]);
  });
});

describe("seats that are switched off", () => {
  const seat = parseSeatSettings({
    seat: "developer-2",
    title: "Senior developer 2",
    role: "implementer",
    duties: ["plans", "builds"],
    harness: "pi",
    defined: { active: "on", harness: "pi", model: "gpt-6-astra", access: "full" },
    now: { active: "on", harness: "pi", model: "gpt-6-astra", access: "full" },
    may: { active: ["on", "off"], harness: ["pi"], model: true, reasoning: ["low"], access: [] },
    set: { active: "off", model: "gpt-6-sol" },
    effective: { active: "off", harness: "pi", model: "gpt-6-sol", access: "full" },
  });

  it("keeps what is set for a seat that is off", () => {
    expect(seat.set).toEqual({ active: "off", model: "gpt-6-sol" });
    expect([seat.effective.active, seat.effective.model, seat.duties]).toEqual([
      "off",
      "gpt-6-sol",
      ["plans", "builds"],
    ]);
    expect(seatIsOn(seat, {})).toBe(true);
    expect(seatIsOn(seat, { active: "off" })).toBe(false);
  });

  it("sends a switch only where it differs from what the seat is set to", () => {
    expect(seatSettingsToSend([seat], { "developer-2": { active: "off" } })).toEqual({
      "developer-2": { active: "off" },
    });
    expect(seatSettingsToSend([seat], { "developer-2": { active: "on" } })).toEqual({});
    expect(
      seatSettingsToSend([seat], { "developer-2": { active: "off", model: "gpt-6-sol" } }),
    ).toEqual({ "developer-2": { active: "off", model: "gpt-6-sol" } });
    // A seat that is off by default is switched on by saying so.
    const off = { ...seat, now: { ...seat.now, active: "off" } };
    expect(seatSettingsToSend([off], { "developer-2": { active: "on" } })).toEqual({
      "developer-2": { active: "on" },
    });
  });
});

describe("a task in a flow", () => {
  const card = { id: "task-1", number: 1001, title: "Plan a cache", lane: "human-review" };
  it("reads the plan it stopped at, and the review it made", () => {
    const planned = parseTask({
      id: "task-1",
      state: "planned",
      workflow: "plan",
      card: { ...card, flow: "plan", state: "planned" },
      flows: [flow("plan"), flow("standard", { offered: false })],
      seatsOn: ["advocate", "sceptic"],
      plan: {
        run: "run-1",
        agreed: false,
        approach: "Put it in front.",
        steps: ["read", "write"],
        checks: [],
        comments: [{ seat: "sceptic", stance: "agree", points: [] }],
        file: "C:/engine/runs/run-1/evidence/PLAN.md",
      },
    });
    expect([planned?.workflow, planned?.card.flow, planned?.seatsOn]).toEqual([
      "plan",
      "plan",
      ["advocate", "sceptic"],
    ]);
    expect([planned?.plan?.agreed, planned?.plan?.steps, planned?.plan?.comments[0]?.seat]).toEqual(
      [false, ["read", "write"], "sceptic"],
    );
    expect(planned?.review).toBeNull();

    const reviewed = parseTask({
      id: "task-2",
      state: "reviewed",
      workflow: "review",
      card: { ...card, id: "task-2" },
      review: {
        run: "run-2",
        examined: "abc",
        missing: ["qa-third"],
        file: "REVIEW.md",
        seats: [
          {
            seat: "lead",
            harness: "codex",
            summary: "Holds.",
            checked: ["a.txt"],
            findings: [{ title: "No test", where: "a.txt:1", detail: "None.", blocking: true }],
          },
        ],
      },
    });
    expect(reviewed?.review?.seats[0]?.findings).toEqual([
      { title: "No test", where: "a.txt:1", detail: "None.", blocking: true },
    ]);
    expect(reviewed?.review?.missing).toEqual(["qa-third"]);
    // A card of an engine from before flows is a delivery.
    expect(parseTask({ id: "task-3", state: "doing", card })?.card.flow).toBe("standard");
  });
});

describe("profiles", () => {
  it("lists the teams of the engine and the ones a person made, with why one could not be read", () => {
    const profiles = parseProfiles([
      { profile: "development", source: "built-in", editable: false, seats: 7, seatsOn: 7 },
      {
        profile: "two-minds",
        source: "custom",
        editable: true,
        revision: 3,
        seats: 3,
        seatsOn: 2,
        flows: ["chat", "plan"],
        problem: "profiles/two-minds/team.json: seat ghost: roles/ghost.md is missing",
      },
      { source: "custom" },
    ]);
    expect(
      profiles.map((item) => [item.profile, item.editable, item.seatsOn, item.problem]),
    ).toEqual([
      ["development", false, 7, null],
      ["two-minds", true, 2, "profiles/two-minds/team.json: seat ghost: roles/ghost.md is missing"],
    ]);
  });

  it("reads a profile as the form it is edited in", () => {
    const view = parseProfile({
      profile: "two-minds",
      name: "two-minds",
      source: "custom",
      editable: true,
      revision: 2,
      purpose: "Weighs ideas.",
      corePrompt: "# Two minds",
      defaultFlow: "chat",
      memory: { scope: "profile", notes: "Short answers.", scopes: { profile: "Keeps notes." } },
      references: ["C:/brief.md", 3],
      lead: "advocate",
      seats: [
        {
          id: "advocate",
          title: "Advocate",
          role: "advocate",
          instructions: "Argue for it.",
          active: true,
          harness: "claude",
          model: "claude-opus-5-5",
          duties: ["plan"],
        },
        { id: "scribe", instructions: "Write.", active: false, harness: "kimi" },
      ],
      tools: ["delivery"],
      toolsOffered: [{ server: "delivery", offers: ["team_context"] }],
      harnesses: { kimi: { model: false, reasoning: [], access: ["full"] } },
      history: [{ revision: 2, by: "Sam", at: "2026-09-28T10:00:00Z", note: "two seats" }],
      note: "What is started from now on uses revision 2.",
    });
    expect([view?.form.name, view?.form.memory, view?.form.references]).toEqual([
      "two-minds",
      { scope: "profile", notes: "Short answers." },
      ["C:/brief.md"],
    ]);
    expect(view?.form.seats.map((seat) => [seat.id, seat.title, seat.active, seat.model])).toEqual([
      ["advocate", "Advocate", true, "claude-opus-5-5"],
      ["scribe", "scribe", false, null],
    ]);
    expect([view?.seats, view?.harnesses.kimi?.model, view?.history[0]?.note]).toEqual([
      2,
      false,
      "two seats",
    ]);
    expect(parseProfile({ error: "no profile" })).toBeNull();
  });
});

describe("the setup of a seat", () => {
  const setup = parseSeatSetup({
    team: "development",
    configuration: "development@4#abc",
    flow: "standard",
    seat: { seat: "developer", harness: "claude", on: true },
    seats: [{ seat: "developer" }, { seat: "support", on: false, installed: false }],
    instructions: [
      { name: "project", source: "AGENTS.md", text: null, note: "Read by the harness." },
      { name: "team", source: "TEAM.md", file: "C:/teams/development/TEAM.md", text: "# Team" },
    ],
    tools: [
      { server: "delivery", state: "working", forThisSeat: true, reachable: true, route: "MCP" },
      {
        server: "pages",
        state: "working",
        forThisSeat: true,
        reachable: true,
        checked: {
          at: "2026-09-28T10:00:00Z",
          connected: true,
          exercised: true,
          tools: [{ name: "host_page_read", description: "Reads a page." }],
        },
      },
      { server: "browser", state: "not-for-this-seat", whyNotForThisSeat: "no browser" },
      { server: "odd", state: "splendid" },
    ],
    specialists: [
      {
        name: "backend",
        kind: "agent",
        how: "Started by the engine.",
        host: { seat: "developer", harness: "claude", model: "claude-fable-5-1" },
        history: { started: 2, done: 1, last: { run: "run-1", at: "now", state: "done" } },
      },
      { name: "scoring" },
    ],
  });

  it("never takes a tool for working that was not seen to work", () => {
    expect(setup?.tools.map((tool) => [tool.server, tool.state])).toEqual([
      // Said to work, with nothing to show for it.
      ["delivery", "not-checked"],
      ["pages", "working"],
      ["browser", "not-for-this-seat"],
      ["odd", "not-checked"],
    ]);
    expect(setup?.tools[1]?.checked?.tools).toEqual([
      { name: "host_page_read", description: "Reads a page." },
    ]);
  });

  it("reads the instructions with their sources, the seats, and what a specialist is", () => {
    expect(setup?.instructions.map((layer) => [layer.name, layer.file, layer.text])).toEqual([
      ["project", null, null],
      ["team", "C:/teams/development/TEAM.md", "# Team"],
    ]);
    expect(setup?.seats.map((seat) => [seat.seat, seat.on, seat.installed])).toEqual([
      ["developer", true, true],
      ["support", false, false],
    ]);
    expect(setup?.specialists.map((item) => [item.name, item.kind, item.history.started])).toEqual([
      ["backend", "agent", 2],
      // What does not say what it is, is taken for words and nothing more.
      ["scoring", "prompt", 0],
    ]);
    expect(parseSeatSetup({ team: "x" })).toBeNull();
  });
});
