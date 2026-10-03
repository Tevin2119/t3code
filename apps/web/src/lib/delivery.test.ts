import { describe, expect, it } from "vite-plus/test";

import {
  decideTeamForSend,
  deliveryFailureText,
  describeBinding,
  isStaleReading,
  deliveryFailureProblems,
  moveSeat,
  parseBoard,
  crewLine,
  nowLine,
  parseBoardSeats,
  parseCards,
  parseSeatSettings,
  parseTask,
  parseTeamDefaults,
  parseTeamProfile,
  parseTeams,
  parseTrackRecord,
  resolveTeamChoice,
  rolesForHarness,
  seatOfferFor,
  seatSettingsToSend,
  seatSources,
  teamTaskBlock,
  withFallbacks,
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

const card = (overrides: Record<string, unknown> = {}) => ({
  id: "task-1",
  number: 1001,
  title: "Add a file",
  team: "development",
  lane: "validation",
  state: "doing",
  revision: 2,
  origin: "person",
  owner: "Sam",
  priority: "high",
  priorityBy: "triage",
  tags: ["engine", 7],
  created: "2026-09-28T09:00:00Z",
  updated: "2026-09-28T10:00:00Z",
  submitted: "2026-09-28T09:01:00Z",
  held: false,
  parts: [{ id: "task-2", number: 1002, title: "Part", lane: "human-review", state: "doing" }],
  partsDelivered: 1,
  run: { id: "run-1", state: "running", stage: "qa", candidate: "abc", configuration: "c" },
  stage: "qa",
  workers: [
    { seat: "qa-attack", harness: "opencode", role: "qa-attack", stage: "qa" },
    {
      seat: "qa-validate",
      harness: "kimi",
      role: "qa-validate",
      stage: "qa",
      waiting: "memory headroom",
    },
  ],
  paused: null,
  qa: { votes: [{ seat: "qa-third", provider: "deepseek", verdict: "pass" }], needed: 2 },
  findings: { open: 1, all: 3 },
  approvals: [{ actor: "Sam", decision: "approve", stands: false }],
  questions: 1,
  unread: 2,
  unanswered: 1,
  files: 3,
  last: { at: "2026-09-28T10:00:00Z", by: "lead", from: "team", kind: "question", text: "Which?" },
  blocker: "Which folder?",
  waitingOn: "person",
  actions: ["stop", 7],
  ...overrides,
});

describe("parseBoard", () => {
  it("reads lanes and cards and drops what it cannot read", () => {
    const board = parseBoard({
      view: "development",
      views: [{ id: "development", title: "Development" }],
      teams: ["development", "rnd"],
      waiting: 1,
      lanes: [{ lane: "validation", title: "Testing", cards: [card(), "not a card"] }],
      notices: [{ key: "seat:x", kind: "credit", text: "Out of credit.", count: 2 }],
      note: null,
    });
    expect(board?.lanes[0]?.cards).toHaveLength(1);
    const read = board?.lanes[0]?.cards[0];
    expect(read?.findings).toEqual({ open: 1, all: 3 });
    expect(read?.actions).toEqual(["stop"]);
    expect(read?.approvals[0]?.stands).toBe(false);
    expect(read?.run?.stage).toBe("qa");
    expect(board?.notices[0]?.count).toBe(2);
    expect([board?.waiting, board?.teams]).toEqual([1, ["development", "rnd"]]);
  });

  it("reads what a card shows: its number, who holds it, and what waits", () => {
    const read = parseBoard({ lanes: [{ lane: "validation", title: "Testing", cards: [card()] }] })
      ?.lanes[0]?.cards[0];
    expect([read?.number, read?.priority, read?.priorityBy, read?.owner]).toEqual([
      1001,
      "high",
      "triage",
      "Sam",
    ]);
    expect(read?.tags).toEqual(["engine"]);
    expect(read?.workers).toEqual([
      {
        seat: "qa-attack",
        harness: "opencode",
        role: "qa-attack",
        stage: "qa",
        specialist: null,
        since: null,
        waiting: null,
      },
      // One the engine holds is read as waiting, with what for.
      {
        seat: "qa-validate",
        harness: "kimi",
        role: "qa-validate",
        stage: "qa",
        specialist: null,
        since: null,
        waiting: "memory headroom",
      },
    ]);
    expect([read?.questions, read?.unread, read?.unanswered, read?.files]).toEqual([1, 2, 1, 3]);
    expect([read?.waitingOn, read?.blocker]).toEqual(["person", "Which folder?"]);
    expect(read?.qa).toEqual({
      votes: [{ seat: "qa-third", provider: "deepseek", verdict: "pass" }],
      needed: 2,
    });
    expect([read?.parts[0]?.number, read?.partsDelivered]).toEqual([1002, 1]);
  });

  it("takes a priority it does not know for the usual one", () => {
    const read = parseBoard({
      lanes: [{ lane: "ready", title: "Ready", cards: [card({ priority: "whenever" })] }],
    })?.lanes[0]?.cards[0];
    expect(read?.priority).toBe("medium");
  });

  it("is null for an answer that is not a board", () => {
    expect(parseBoard({ error: "not found" })).toBeNull();
    expect(parseBoard(null)).toBeNull();
  });
});

describe("parseCards", () => {
  it("reads what a search answers with", () => {
    expect(parseCards([card(), { title: "no id" }, null]).map((item) => item.number)).toEqual([
      1001,
    ]);
    expect(parseCards({ error: "no" })).toEqual([]);
  });
});

const seatSetting = (overrides: Record<string, unknown> = {}) => ({
  seat: "lead",
  title: "Lead developer",
  role: "team-lead",
  harness: "codex",
  provider: "openai",
  defined: { harness: "codex", model: "gpt-6-astra", reasoning: null, access: "full" },
  now: { harness: "codex", model: "gpt-6-astra", reasoning: null, access: "full" },
  saved: {},
  models: ["gpt-6-astra", "gpt-6-sol"],
  may: {
    harness: ["claude", "codex", "kimi"],
    model: true,
    reasoning: ["low", "high"],
    access: ["full", "read-only"],
  },
  byHarness: {
    claude: { model: true, reasoning: ["low", "high", "max"], access: ["full", "workspace"] },
    codex: { model: true, reasoning: ["low", "high"], access: ["full", "read-only"] },
    kimi: { model: false, reasoning: [], access: ["full"] },
  },
  why: {},
  ...overrides,
});

describe("parseTask", () => {
  const task = parseTask({
    id: "task-1",
    number: 1001,
    title: "Add a file",
    body: "Add one file.",
    requirements: ["No new dependency"],
    acceptance: ["The file is there"],
    revision: 2,
    state: "needs-decision",
    lane: "needs-decision",
    team: "development",
    priority: "urgent",
    priorityBy: "person",
    tags: ["engine"],
    owner: "Sam",
    origin: "person",
    created: "2026-09-28T09:00:00Z",
    updated: "2026-09-28T10:00:00Z",
    submitted: "2026-09-28T09:01:00Z",
    card: card({ lane: "needs-decision" }),
    actions: ["retry", "retriage"],
    timeline: [
      {
        id: "e4",
        at: "2026-09-28T09:01:00Z",
        source: "event",
        kind: "task.submitted",
        by: "Sam",
        text: "Submitted to team development.",
        icon: "submitted",
        detail: false,
      },
      {
        id: "e9",
        at: "2026-09-28T09:02:00Z",
        source: "event",
        kind: "attempt.started",
        by: "classifier on claude",
        text: "Started triage.",
        icon: "work",
        detail: true,
      },
      {
        id: "m3",
        seq: 3,
        at: "2026-09-28T09:30:00Z",
        source: "message",
        kind: "question",
        by: "lead",
        sender: "team",
        text: "Which folder?",
        state: "open",
        replyTo: null,
        files: [],
      },
      {
        id: "m4",
        seq: 4,
        at: "2026-09-28T09:40:00Z",
        source: "message",
        kind: "answer",
        by: "Sam",
        sender: "person",
        text: "The docs folder.",
        state: "applied",
        replyTo: 3,
        revision: 2,
        files: [
          {
            id: "file-1",
            name: "screenshot.png",
            type: "image/png",
            size: 2048,
            by: "Sam",
            at: "2026-09-28T09:39:00Z",
            message: 4,
            path: "C:/engine/files/task-1/file-1-screenshot.png",
          },
        ],
      },
      {
        id: "m5",
        seq: 5,
        at: "2026-09-28T09:45:00Z",
        source: "message",
        kind: "proposal",
        by: "coordinator",
        sender: "coordinator",
        text: "I read this as a change.",
        state: "open",
        change: { text: "Also add a test." },
      },
    ],
    questions: [{ seq: 3, at: "2026-09-28T09:30:00Z", by: "lead", text: "Which folder?" }],
    proposals: [
      {
        seq: 5,
        at: "2026-09-28T09:45:00Z",
        by: "coordinator",
        text: "I read this as a change.",
        change: { text: "Also add a test." },
      },
    ],
    files: [],
    links: [
      {
        id: "task-9",
        number: 1009,
        title: "Other",
        state: "ready",
        lane: "ready",
        kind: "depends-on",
        direction: "out",
      },
      { kind: "related" },
    ],
    revisions: [{ revision: 1, notes: null, created: "2026-09-28T09:00:00Z", body: "Add." }],
    settings: [
      {
        ...seatSetting(),
        set: { harness: "claude", model: "claude-opus-5-5", reasoning: "" },
        effective: {
          harness: "claude",
          model: "claude-opus-5-5",
          reasoning: null,
          access: "full",
          provider: "anthropic",
        },
      },
    ],
    defaults: 3,
    working: true,
    council: {
      run: "run-1",
      state: "running",
      stage: "qa",
      configuration: "development@4#abc",
      seats: [
        {
          seat: "lead",
          role: "team-lead",
          harness: "claude",
          provider: "anthropic",
          required: true,
          requestedModel: "claude-opus-5-5",
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
    pendingFromPerson: 0,
    kind: "orchestrator",
  });

  it("reads one history of what was said and what happened, in the order given", () => {
    expect(task?.timeline.map((entry) => [entry.id, entry.source, entry.detail])).toEqual([
      ["e4", "event", false],
      ["e9", "event", true],
      ["m3", "message", false],
      ["m4", "message", false],
      ["m5", "message", false],
    ]);
    const answer = task?.timeline[3];
    expect([answer?.sender, answer?.state, answer?.replyTo, answer?.revision]).toEqual([
      "person",
      "applied",
      3,
      2,
    ]);
    expect(answer?.files.map((file) => [file.name, file.size, file.message])).toEqual([
      ["screenshot.png", 2048, 4],
    ]);
    expect(task?.timeline[4]?.change).toBe("Also add a test.");
  });

  it("reads what waits for a person", () => {
    expect(task?.questions.map((question) => question.seq)).toEqual([3]);
    expect(task?.proposals[0]?.change).toBe("Also add a test.");
    expect([task?.number, task?.isDraft, task?.priority, task?.working]).toEqual([
      1001,
      false,
      "urgent",
      true,
    ]);
    expect(task?.links).toHaveLength(2);
    expect([task?.links[0]?.kind, task?.links[0]?.direction]).toEqual(["depends-on", "out"]);
  });

  it("keeps a model for each seat and never invents the one a harness used", () => {
    const lead = task?.council?.seats[0];
    expect([lead?.requestedModel, lead?.actualModel, lead?.activity, lead?.blockedBy]).toEqual([
      "claude-opus-5-5",
      null,
      "queued",
      "global limit",
    ]);
    expect(lead?.attempts).toBe(2);
    expect(task?.council?.concurrency).toEqual({ active: 4, waiting: 1, global: 4 });
    expect(task?.settings[0]?.set).toEqual({ harness: "claude", model: "claude-opus-5-5" });
    expect(task?.settings[0]?.effective.harness).toBe("claude");
    expect(task?.defaults).toBe(3);
  });

  it("knows a draft, and is null for what is not a task", () => {
    expect(
      parseTask({ id: "task-2", state: "draft", card: card({ lane: "draft" }) })?.isDraft,
    ).toBe(true);
    expect(parseTask({ id: "task-2" })).toBeNull();
    expect(parseTask({ error: "no task" })).toBeNull();
  });
});

describe("seat settings", () => {
  const lead = parseSeatSettings(seatSetting());
  const support = parseSeatSettings(
    seatSetting({
      seat: "support",
      title: "Maintainer",
      harness: "kimi",
      defined: { harness: "kimi", model: null, reasoning: null, access: "full" },
      now: { harness: "kimi", model: null, reasoning: null, access: "full" },
      may: { harness: ["claude", "codex", "kimi"], model: false, reasoning: [], access: ["full"] },
    }),
  );

  it("sends only what differs from the team default", () => {
    expect(
      seatSettingsToSend([lead, support], {
        lead: { model: "gpt-6-astra", reasoning: "high", access: " full " },
        support: { model: "" },
        nobody: { reasoning: "high" },
      }),
    ).toEqual({ lead: { reasoning: "high" } });
    expect(seatSettingsToSend([lead, support], {})).toEqual({});
    // The harness a seat already runs on is no change.
    expect(seatSettingsToSend([lead], { lead: { harness: "codex", model: "gpt-6-sol" } })).toEqual({
      lead: { model: "gpt-6-sol" },
    });
  });

  it("sends a seat that was moved with its model, even one named like the default", () => {
    expect(
      seatSettingsToSend([lead], { lead: { harness: "claude", model: "gpt-6-astra" } }),
    ).toEqual({ lead: { harness: "claude", model: "gpt-6-astra" } });
  });

  it("lays defaults over the definition and a task over the defaults", () => {
    const saved = parseSeatSettings(
      seatSetting({
        now: { harness: "codex", model: "gpt-6-sol", reasoning: "high", access: "full" },
        saved: { model: "gpt-6-sol", reasoning: "high" },
      }),
    );
    expect(saved.saved).toEqual({ model: "gpt-6-sol", reasoning: "high" });
    // For a task, what is already the team default is not sent again.
    expect(seatSettingsToSend([saved], { lead: { model: "gpt-6-sol" } })).toEqual({});
    // For the defaults themselves, it is what differs from the definition that is saved.
    expect(seatSettingsToSend([saved], { lead: { model: "gpt-6-sol" } }, "defined")).toEqual({
      lead: { model: "gpt-6-sol" },
    });
    expect(seatSettingsToSend([saved], { lead: { model: "gpt-6-astra" } }, "defined")).toEqual({});
  });

  it("offers what the harness a seat is moved to takes", () => {
    expect(seatOfferFor(lead, {}).reasoning).toEqual(["low", "high"]);
    expect(seatOfferFor(lead, { harness: "claude" })).toEqual({
      model: true,
      reasoning: ["low", "high", "max"],
      access: ["full", "workspace"],
    });
    expect(seatOfferFor(lead, { harness: "kimi" }).model).toBe(false);
    expect(seatOfferFor(lead, { harness: "abacus" })).toEqual({
      model: false,
      reasoning: [],
      access: [],
    });
  });

  it("keeps of a seat's choices only what the harness it moves to takes too", () => {
    const chosen = { reasoning: "high", access: "read-only" };
    expect(moveSeat(lead, chosen, { harness: "claude", model: "claude-opus-5-5" })).toEqual({
      harness: "claude",
      model: "claude-opus-5-5",
      reasoning: "high",
    });
    // A harness that keeps its own model is not given one.
    expect(moveSeat(lead, chosen, { harness: "kimi", model: "k3" })).toEqual({ harness: "kimi" });
  });
});

describe("teamTaskBlock", () => {
  it("lets a task be given only to a team that has a flow and can work", () => {
    const [development, rnd] = parseTeams([
      { team: "development", available: true, takesTasks: true },
      {
        team: "rnd",
        available: true,
        takesTasks: false,
        whyNoTasks: "team rnd works in sessions a person opens.",
      },
    ]);
    expect(teamTaskBlock(development!)).toBeNull();
    expect(teamTaskBlock(rnd!)).toBe("team rnd works in sessions a person opens.");
    expect(
      teamTaskBlock({ ...development!, available: false, why: "codex is not installed" }),
    ).toBe("codex is not installed");
    // An engine from before teams were told apart says nothing, and is taken at its word.
    expect(parseTeams([{ team: "development", available: true }])[0]?.takesTasks).toBe(true);
  });
});

describe("parseTeamDefaults", () => {
  it("reads the defaults, the shares of the builds, and every saving", () => {
    const read = parseTeamDefaults({
      team: "development",
      purpose: "Build.",
      configuration: "development@4#abc",
      available: true,
      seats: [seat({ title: "Senior developer 1", stages: ["plan", "build"], inGate: false })],
      settings: [seatSetting()],
      gates: { qa: { seats: ["qa-attack", "qa-third"], minimumPassingProviders: 2 } },
      defaults: { revision: 2, by: "Sam", at: "2026-09-28T10:00:00Z", problems: [] },
      workload: {
        build: { developer: 1, "developer-2": 1 },
        defined: { developer: 3, "developer-2": 1 },
      },
      history: [
        {
          revision: 2,
          by: "Sam",
          at: "2026-09-28T10:00:00Z",
          note: "Opus this week",
          seats: { developer: { model: "claude-opus-5-5", reasoning: "" } },
          workload: { build: { developer: 1, "developer-2": 1 } },
        },
      ],
      note: "The defaults apply to runs admitted from now on.",
    });
    expect(read?.team.defaults.revision).toBe(2);
    expect(read?.team.workload).toEqual({
      build: { developer: 1, "developer-2": 1 },
      defined: { developer: 3, "developer-2": 1 },
    });
    expect(read?.team.qaGate).toEqual({ seats: ["qa-attack", "qa-third"], minimum: 2 });
    expect(read?.team.seats[0]?.stages).toEqual(["plan", "build"]);
    expect(read?.history[0]?.seats).toEqual({ developer: { model: "claude-opus-5-5" } });
    expect(read?.history[0]?.workload).toEqual({ developer: 1, "developer-2": 1 });
    expect(parseTeamDefaults({ error: "no team" })).toBeNull();
  });
});

describe("deliveryFailureProblems", () => {
  it("lists what the engine said is wrong, one entry for each", () => {
    expect(
      deliveryFailureProblems({
        _tag: "DeliveryError",
        reason: "refused",
        detail: "the seat settings cannot be used",
        body: { error: "x", problems: ["lead: needs a model", 4] },
      }),
    ).toEqual(["lead: needs a model"]);
    expect(deliveryFailureProblems(new Error("down"))).toEqual([]);
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

describe("seat layers and fallbacks", () => {
  it("names the layers a seat's default comes from, other than its definition", () => {
    const item = parseSeatSettings(
      seatSetting({
        source: { harness: "team definition", model: "board Pilot", access: "team defaults" },
      }),
    );
    expect(seatSources(item)).toEqual(["board Pilot", "team defaults"]);
    expect(seatSources(parseSeatSettings(seatSetting()))).toEqual([]);
  });

  it("tells fallbacks a layer names apart from none named", () => {
    const named = parseSeatSettings(
      seatSetting({
        saved: {
          model: "gpt-6-sol",
          fallbacks: [{ harness: "kimi" }, { harness: "claude", model: "claude-opus-5-5" }],
        },
        board: {},
        fallbacks: [{ harness: "kimi" }],
        fallbacksAllowed: true,
      }),
    );
    expect(named.saved).toEqual({ model: "gpt-6-sol" });
    expect(named.savedFallbacks).toEqual([
      { harness: "kimi", model: null },
      { harness: "claude", model: "claude-opus-5-5" },
    ]);
    expect(named.boardFallbacks).toBeNull();
    expect(named.fallbacksAllowed).toBe(true);
  });

  it("sends fallbacks for the seats that name some or none, with a model only where one is given", () => {
    expect(
      withFallbacks(
        { lead: { model: "gpt-6-sol" } },
        {
          lead: [{ harness: "kimi", model: null }],
          reviewer: null,
          tester: [],
        },
      ),
    ).toEqual({
      lead: { model: "gpt-6-sol", fallbacks: [{ harness: "kimi" }] },
      tester: { fallbacks: [] },
    });
  });

  it("reads a board's seats as the engine lists them and as it answers a saving", () => {
    const listed = [
      { team: "development", seats: [seatSetting({ board: { model: "gpt-6-sol" } })] },
    ];
    expect(parseBoardSeats(listed)[0]?.settings[0]?.board).toEqual({ model: "gpt-6-sol" });
    expect(parseBoardSeats({ teams: listed, note: "Saved." })).toHaveLength(1);
  });

  it("reads the track record and drops counts that are not numbers", () => {
    const [row] = parseTrackRecord({
      since: null,
      rows: [
        {
          team: "triage",
          stage: "triage",
          harness: "kimi",
          model: null,
          attempts: 4,
          answered: 3,
          answeredShare: 75,
          medianSeconds: 41,
          notAnswered: { "rate-limit": 1, odd: "x" },
          decisions: { build: 2, decide: 1 },
          verdicts: {},
          steppedIn: 1,
        },
      ],
    });
    expect(row).toMatchObject({
      harness: "kimi",
      model: null,
      answered: 3,
      answeredShare: 75,
      notAnswered: { "rate-limit": 1 },
      decisions: { build: 2, decide: 1 },
      steppedIn: 1,
    });
    expect(parseTrackRecord(null)).toEqual([]);
  });
});

describe("seats at work and seats held", () => {
  const worker = (seat: string, waiting: string | null = null) => ({
    seat,
    harness: null,
    role: null,
    stage: "qa",
    specialist: null,
    since: null,
    waiting,
  });
  it("says working while any seat works, and waiting, for what, while every seat is held", () => {
    expect(
      nowLine({
        workers: [worker("qa-attack"), worker("qa-validate", "memory headroom")],
        stage: "qa",
      }),
    ).toBe("Working: qa");
    expect(nowLine({ workers: [worker("qa-validate", "memory headroom")], stage: "qa" })).toBe(
      "Waits for memory: qa",
    );
    expect(
      nowLine({
        workers: [worker("a", "memory headroom"), worker("b", "a free slot")],
        stage: "qa",
      }),
    ).toBe("Waiting: qa");
    expect(nowLine({ workers: [], stage: "qa" })).toBeNull();
  });
  it("names every seat once, each held one with its own reason", () => {
    expect(
      crewLine({
        workers: [
          worker("qa-attack"),
          worker("qa-validate", "memory headroom"),
          worker("qa-third", "a free slot"),
        ],
      }),
    ).toBe("qa-attack working; qa-validate waits for memory; qa-third waits for a free slot");
  });
  it("reads a board's seats revision, and the defined chain falls back for an older engine", () => {
    expect(parseBoardSeats([{ team: "development", revision: 3, seats: [] }])[0]?.revision).toBe(3);
    const older = parseSeatSettings(
      seatSetting({ fallbackChain: [{ harness: "claude", model: "claude-opus-5-5" }] }),
    );
    expect(older.definedFallbackChain).toEqual([{ harness: "claude", model: "claude-opus-5-5" }]);
  });
});
