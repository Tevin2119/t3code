import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { parseTeams } from "./delivery";
import { resolveOrchestratorRoster } from "./orchestratorChat";

function provider(driver: string, instanceId = driver): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

function setup() {
  const team = parseTeams([
    {
      team: "research",
      available: true,
      seats: [
        {
          seat: "scout",
          title: "Scout",
          role: "researcher",
          harness: "claude",
          model: "custom-claude",
          available: true,
        },
        {
          seat: "critic",
          title: "Critic",
          role: "reviewer",
          harness: "codex",
          model: "custom-codex",
          available: true,
        },
      ],
      settings: [
        {
          seat: "critic",
          harness: "codex",
          now: { model: "custom-codex", reasoning: "high", active: "on" },
        },
      ],
    },
  ])[0]!;
  const entries = deriveProviderInstanceEntries([provider("claudeAgent"), provider("codex")]);
  return { team, entries, choices: undefined };
}

it("retains configured models and reasoning across different harnesses before their catalogs load", () => {
  const result = resolveOrchestratorRoster(setup());
  expect(result.problem).toBeNull();
  expect(result.configuration).not.toHaveProperty("critique");
  expect(resolveOrchestratorRoster({ ...setup(), critique: "never" }).configuration?.critique).toBe(
    "never",
  );
  expect(result.configuration?.participants).toEqual([
    {
      seat: "scout",
      role: "researcher",
      modelSelection: { instanceId: "claudeAgent", model: "custom-claude" },
    },
    {
      seat: "critic",
      role: "reviewer",
      modelSelection: {
        instanceId: "codex",
        model: "custom-codex",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    },
  ]);
});

it("requires an explicit instance when the team's harness identifies two enabled providers", () => {
  const input = setup();
  const entries = [
    ...input.entries,
    ...deriveProviderInstanceEntries([provider("claudeAgent", "claude-work")]),
  ];
  expect(resolveOrchestratorRoster({ ...input, entries }).configuration).toBeNull();
  const result = resolveOrchestratorRoster({
    ...input,
    entries,
    choices: {
      scout: {
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claude-work"),
          "chosen-claude",
        ),
      },
    },
  });
  expect(result.problem).toBeNull();
  expect(result.configuration?.participants[0]?.modelSelection).toEqual({
    instanceId: "claude-work",
    model: "chosen-claude",
  });
});

it("does not substitute another provider when the explicitly selected instance becomes unavailable", () => {
  const input = setup();
  const chosen = createModelSelection(ProviderInstanceId.make("claude-work"), "chosen-claude");
  const entries = [
    ...input.entries,
    ...deriveProviderInstanceEntries([
      { ...provider("claudeAgent", "claude-work"), enabled: false },
    ]),
  ];
  const result = resolveOrchestratorRoster({
    ...input,
    entries,
    choices: { scout: { modelSelection: chosen } },
  });
  expect(result.configuration).toBeNull();
  expect(result.rows[0]?.modelSelection).toEqual(chosen);
  expect(result.rows[0]?.problem).toMatch(/unavailable/);
});

it("holds a changed roster instead of sending stale seats or a single remaining participant", () => {
  const input = setup();
  expect(
    resolveOrchestratorRoster({ ...input, choices: { removed: { included: false } } })
      .configuration,
  ).toBeNull();
  expect(
    resolveOrchestratorRoster({ ...input, choices: { scout: { included: false } } }).configuration,
  ).toBeNull();
  const duplicate = createModelSelection(ProviderInstanceId.make("codex"), "custom-codex");
  expect(
    resolveOrchestratorRoster({ ...input, choices: { scout: { modelSelection: duplicate } } })
      .configuration,
  ).toBeNull();
});

it("gives a seat with no model its provider's default, and leaves out the orchestrator's own seat", () => {
  const input = setup();
  const team = parseTeams([
    {
      team: "research",
      available: true,
      seats: [
        ...input.team.seats,
        { seat: "checker", title: "Checker", role: "checker", harness: "kimi", available: true },
      ],
      settings: input.team.settings,
    },
  ])[0]!;
  const entries = [
    ...input.entries,
    ...deriveProviderInstanceEntries([
      {
        ...provider("kimi"),
        models: [
          { slug: "kimi-other", name: "Other", isCustom: false, capabilities: null },
          { slug: "kimi-main", name: "Main", isCustom: false, isDefault: true, capabilities: null },
        ],
      },
    ]),
  ];
  const result = resolveOrchestratorRoster({
    team,
    entries,
    choices: undefined,
    orchestrator: { harness: "codex", role: "reviewer" },
  });
  expect(result.problem).toBeNull();
  expect(result.configuration?.participants.map((seat) => seat.seat)).toEqual(["scout", "checker"]);
  expect(result.rows.filter((row) => row.orchestrator).map((row) => row.seat)).toEqual(["critic"]);
  expect(result.configuration?.participants[1]?.modelSelection).toEqual({
    instanceId: "kimi",
    model: "kimi-main",
  });
  // Asked back in, the orchestrator's seat takes part again.
  expect(
    resolveOrchestratorRoster({
      team,
      entries,
      choices: { critic: { included: true } },
      orchestrator: { harness: "codex", role: "reviewer" },
    }).configuration?.participants,
  ).toHaveLength(3);
});

it("says why a seat's provider cannot be used and what to do about it", () => {
  const input = setup();
  const entries = deriveProviderInstanceEntries([
    { ...provider("claudeAgent"), status: "warning", message: "It did not list any models yet." },
    provider("codex"),
  ]);
  const problem = resolveOrchestratorRoster({ ...input, entries }).rows[0]?.problem;
  expect(problem).toContain("It did not list any models yet.");
  expect(problem).toContain("leave it out");
  expect(
    resolveOrchestratorRoster({ ...input, entries: input.entries.slice(1) }).rows[0]?.problem,
  ).toContain("No enabled provider runs claude");
});

it("adds participants for one conversation, in a role of the team, beside or instead of its seats", () => {
  const input = setup();
  const team = parseTeams([
    {
      team: "research",
      available: true,
      seats: input.team.seats,
      settings: input.team.settings,
      roles: [
        { role: "researcher", title: "Researcher" },
        { role: "reviewer", title: "Reviewer" },
      ],
    },
  ])[0]!;
  const extra = {
    id: "custom-1",
    role: "reviewer",
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "another-codex"),
  };
  const result = resolveOrchestratorRoster({
    ...input,
    team,
    choices: { critic: { included: false } },
    extras: [extra],
  });
  expect(result.problem).toBeNull();
  expect(result.configuration?.participants.map((seat) => [seat.seat, seat.role])).toEqual([
    ["scout", "researcher"],
    ["custom-1", "reviewer"],
  ]);
  expect(
    resolveOrchestratorRoster({ ...input, team, extras: [{ id: "custom-2", role: "reviewer" }] })
      .problem,
  ).toMatch(/Choose a provider and model for Extra participant 1/);
  expect(
    resolveOrchestratorRoster({ ...input, team, extras: [{ ...extra, role: "gone" }] }).problem,
  ).toMatch(/Choose a role/);
});
