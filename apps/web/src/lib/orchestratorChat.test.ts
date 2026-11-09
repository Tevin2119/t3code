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
