import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { expect, it } from "vite-plus/test";
import {
  buildProviderProblemPrompt,
  providerProblemOfStatus,
  resolveProviderFixModelSelection,
} from "./providerProblem";

function provider(driver: string, status: ServerProvider["status"] = "ready"): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.2.0",
    status,
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: `${driver}-model`, name: driver, isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  };
}

const projectId = ProjectId.make("project");

it("puts the provider, version, exact status and blocked seat in the prompt", () => {
  const prompt = buildProviderProblemPrompt({
    provider: "Kimi",
    version: "0.9.1",
    message:
      "QA, validating's provider is unavailable. Kimi: Limited. Could not read Kimi providers.",
    blocks: "QA, validating",
  });
  expect(prompt).toContain("Provider: Kimi\nVersion: 0.9.1\n");
  expect(prompt).toContain(
    "Status: QA, validating's provider is unavailable. Kimi: Limited. Could not read Kimi providers.",
  );
  expect(prompt).toContain("Blocks: QA, validating");
  expect(prompt).toContain("KIMI_CODE_HOME=~/.polymania/kimi");
});

it("leaves out what is not known", () => {
  const prompt = buildProviderProblemPrompt(
    providerProblemOfStatus({ ...provider("codex"), version: null }, "Codex is unavailable."),
  );
  expect(prompt).not.toContain("Version:");
  expect(prompt).not.toContain("Blocks:");
  expect(prompt).toContain("Status: Codex is unavailable.");
});

it("runs the fix thread on the default provider, never the one with the problem", () => {
  const providers = [provider("kimi", "warning"), provider("codex")];
  const kimi = createModelSelection(ProviderInstanceId.make("kimi"), "kimi-model");
  const claude = createModelSelection(ProviderInstanceId.make("claude"), "claude-model");
  const input = { providers, settings: DEFAULT_SERVER_SETTINGS, projectId };

  expect(
    resolveProviderFixModelSelection({
      ...input,
      defaultSelection: claude,
      broken: ProviderInstanceId.make("kimi"),
    }),
  ).toEqual(claude);
  expect(
    resolveProviderFixModelSelection({
      ...input,
      defaultSelection: kimi,
      broken: ProviderInstanceId.make("kimi"),
    })?.instanceId,
  ).toBe("codex");
  expect(
    resolveProviderFixModelSelection({
      ...input,
      providers: [provider("kimi"), provider("codex")],
      defaultSelection: null,
      broken: ProviderInstanceId.make("kimi"),
    })?.instanceId,
  ).toBe("codex");
});
