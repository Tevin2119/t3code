import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type DeliveryThreadBinding,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  buildModelOptions,
  buildModelMenuActions,
  groupByProvider,
  modelOptionSelectionRefusal,
} from "./modelOptions";
import { canCommitPendingModel } from "../features/threads/thread-settings-sheet-state";

const binding: DeliveryThreadBinding = {
  threadId: ThreadId.make("thread"),
  session: "session",
  team: "development",
  role: "implementer",
  seat: "developer",
  harness: "pi",
  driver: "pi",
  workspace: "/repo",
  configuration: "development@1#digest",
  requestedModel: null,
  memoryScope: "team",
  tools: [],
  project: "project",
  boundAt: "2026-10-13T00:00:00Z",
};
const config = {
  providers: [
    ["pi_work", "pi"],
    ["pi_personal", "pi"],
    ["codex_work", "codex"],
    ["codex_personal", "codex"],
    ["claude_work", "claudeAgent"],
  ].map(([instanceId, driver]) => ({
    instanceId,
    driver,
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    models: ["fast", "pro"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
  })),
} as unknown as ServerConfig;
const current = { instanceId: ProviderInstanceId.make("pi_work"), model: "fast" };
const reason =
  "This thread is the development implementer on pi. Start a new thread to use another harness.";

describe("mobile delivery model options", () => {
  it.each([undefined, current.instanceId])(
    "retains all bound-driver instances and disables foreign models with instance lock=%s",
    (instanceLock) => {
      const options = buildModelOptions(config, current, instanceLock, null, false, binding);
      expect(options).toHaveLength(10);
      for (const option of options) {
        const foreign = option.providerDriver !== "pi";
        expect(option.disabledReason ?? null).toBe(foreign ? reason : null);
        expect(modelOptionSelectionRefusal(option, options)).toBe(foreign ? reason : null);
        expect(canCommitPendingModel(option, groupByProvider(options))).toBe(!foreign);
      }
      const actions = buildModelMenuActions(groupByProvider(options), current).flatMap(
        (action) => action.subactions ?? [],
      );
      expect(actions).toHaveLength(10);
      for (const action of actions) {
        const foreign = !action.id?.startsWith("model:pi_");
        expect(action.attributes?.disabled ?? false).toBe(foreign);
        expect(action.subtitle ?? null).toBe(foreign ? reason : null);
      }
    },
  );
  it("keeps compatible unbound instances and revalidates staged selections on binding changes", () => {
    const unbound = buildModelOptions(config, current, current.instanceId, null);
    expect(unbound).toHaveLength(4);
    expect(unbound.every((option) => !option.disabledReason)).toBe(true);
    const unrestricted = buildModelOptions(config, current, undefined, null);
    const staged = unrestricted.find((option) => option.providerKey === "pi_personal")!;
    expect(
      canCommitPendingModel(
        staged,
        groupByProvider(
          buildModelOptions(config, current, current.instanceId, null, false, binding),
        ),
      ),
    ).toBe(true);
    const different = {
      ...binding,
      team: "review",
      role: "reviewer",
      driver: "claudeAgent",
      harness: "claude",
    };
    const differentOptions = buildModelOptions(config, current, undefined, null, false, different);
    expect(canCommitPendingModel(staged, groupByProvider(differentOptions))).toBe(false);
    expect(modelOptionSelectionRefusal(staged, differentOptions)).toBe(
      "This thread is the review reviewer on claude. Start a new thread to use another harness.",
    );
    expect(canCommitPendingModel(staged, groupByProvider(unrestricted))).toBe(true);
  });
  it("applies the same driver policy to synthetic fallback rows", () => {
    for (const instanceId of ["pi_personal", "codex_work"]) {
      const fallback = { instanceId: ProviderInstanceId.make(instanceId), model: "saved-model" };
      const options = buildModelOptions(config, fallback, current.instanceId, null, false, binding);
      const option = options.find((row) => row.key === `${instanceId}:saved-model`)!;
      expect(option.disabledReason ?? null).toBe(instanceId === "pi_personal" ? null : reason);
    }
  });
  it("retains genuine availability refusal on bound-driver instances", () => {
    const unavailable = {
      ...config,
      providers: config.providers.map((provider) =>
        provider.instanceId === "pi_personal" ? { ...provider, installed: false } : provider,
      ),
    };
    const options = buildModelOptions(unavailable, current, undefined, null, false, binding);
    expect(options.some((option) => option.providerKey === "pi_personal")).toBe(false);
    const fallback = buildModelOptions(
      unavailable,
      {
        instanceId: ProviderInstanceId.make("pi_personal"),
        model: "saved-model",
      },
      undefined,
      null,
      false,
      binding,
    ).find((option) => option.providerKey === "pi_personal")!;
    expect(fallback.isUnavailable).toBe(true);
    expect(fallback.disabledReason ?? null).toBeNull();
    expect(modelOptionSelectionRefusal(fallback, [fallback])).toBe(
      "Set up this provider on web or desktop, or select another model.",
    );
    expect(
      options
        .filter((option) => option.providerDriver === "pi")
        .every((option) => !option.disabledReason),
    ).toBe(true);
  });
  it("preserves hidden-model controls and delivery refusal when managing hidden models", () => {
    const hiddenConfig = {
      ...config,
      settings: {
        providerInstances: Object.fromEntries(
          config.providers.map((provider) => [
            provider.instanceId,
            { driver: provider.driver, enabled: true },
          ]),
        ),
        projectSettingsOverrides: {},
        providerModelPreferences: {
          pi_personal: { hiddenModels: ["fast"], modelOrder: [] },
          codex_work: { hiddenModels: ["fast"], modelOrder: [] },
        },
      },
    } as unknown as ServerConfig;
    const normal = buildModelOptions(
      hiddenConfig,
      current,
      current.instanceId,
      null,
      false,
      binding,
    );
    expect(normal.some((option) => option.key === "pi_personal:fast")).toBe(false);
    const managed = buildModelOptions(
      hiddenConfig,
      current,
      current.instanceId,
      null,
      true,
      binding,
    );
    const hiddenPi = managed.find((option) => option.key === "pi_personal:fast")!;
    expect(hiddenPi.isHidden).toBe(true);
    expect(hiddenPi.disabledReason).toBeUndefined();
    expect(canCommitPendingModel(hiddenPi, groupByProvider(managed))).toBe(false);
    const hiddenForeign = managed.find((option) => option.key === "codex_work:fast")!;
    expect(hiddenForeign.isHidden).toBe(true);
    expect(modelOptionSelectionRefusal(hiddenForeign, managed)).toBe(reason);
    const visiblePi = managed.find((option) => option.key === "pi_personal:pro")!;
    expect(canCommitPendingModel(visiblePi, groupByProvider(managed))).toBe(true);
  });
  it("retains project availability restrictions with a delivery binding", () => {
    const projectId = ProjectId.make("project");
    const projectConfig = {
      ...config,
      settings: {
        providerInstances: Object.fromEntries(
          config.providers.map((provider) => [
            provider.instanceId,
            { driver: provider.driver, enabled: true },
          ]),
        ),
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { pi_personal: { enabled: false } } },
        },
      },
    } as unknown as ServerConfig;
    const options = buildModelOptions(
      projectConfig,
      current,
      current.instanceId,
      projectId,
      false,
      binding,
    );
    expect(options.some((option) => option.providerKey === "pi_personal")).toBe(false);
    const fallback = { instanceId: ProviderInstanceId.make("pi_personal"), model: "fast" };
    const saved = buildModelOptions(
      projectConfig,
      fallback,
      current.instanceId,
      projectId,
      false,
      binding,
    ).find((option) => option.providerKey === "pi_personal")!;
    expect(saved.isUnavailable).toBe(true);
    expect(saved.disabledReason).toBeUndefined();
    expect(canCommitPendingModel(saved, groupByProvider([saved]))).toBe(false);
    const outsideProject = buildModelOptions(
      projectConfig,
      current,
      current.instanceId,
      null,
      false,
      binding,
    );
    expect(outsideProject.filter((option) => option.providerKey === "pi_personal")).toHaveLength(2);
  });
});
