import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
  navigate: vi.fn(),
  canGoBack: true,
}));

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
  useCanGoBack: () => testState.canGoBack,
}));
vi.mock("../../state/usage", () => ({ useUsage: testState.useUsage }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "div",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "div",
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./UsageProviderChart", () => ({ UsageProviderChart: "div" }));
vi.mock("./UsagePriceOverrides", () => ({ UsagePriceOverrides: () => null }));
vi.mock("./usageProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./usageProviders")>();
  return {
    ...actual,
    PROVIDER_ORDER: ["codex", "claude"],
    PROVIDER_PRESENTATION: {
      codex: { color: "white", label: "Codex", mark: "span" },
      claude: { color: "orange", label: "Claude Code", mark: "span" },
    },
  };
});

import { UsagePage } from "./UsagePage";

const providerTotals = (codex: number, claude: number) =>
  new Map([
    ["codex", { costUsd: codex, totalTokens: codex * 1_000 }],
    ["claude", { costUsd: claude, totalTokens: claude * 1_000 }],
  ] as const);

const modelTotals = Object.freeze([
  {
    model: "expensive-model",
    provider: "claude" as const,
    modelProvider: "anthropic",
    modelProviderSource: "harness" as const,
    costUsd: 10,
    totalTokens: 100,
    records: 1,
    unpricedRecords: 0,
    costShare: 10 / 16,
  },
  {
    model: "token-heavy-model",
    provider: "codex" as const,
    modelProvider: null,
    modelProviderSource: null,
    costUsd: 5,
    totalTokens: 1_000,
    records: 1,
    unpricedRecords: 0,
    costShare: 5 / 16,
  },
  {
    model: "token-heavy-cheaper-model",
    provider: "codex" as const,
    modelProvider: null,
    modelProviderSource: null,
    costUsd: 1,
    totalTokens: 1_000,
    records: 1,
    unpricedRecords: 0,
    costShare: 1 / 16,
  },
  {
    model: "unpriced-model",
    provider: "codex" as const,
    modelProvider: null,
    modelProviderSource: null,
    costUsd: 0,
    totalTokens: 500,
    records: 2,
    unpricedRecords: 2,
    costShare: 0,
  },
]);

const environments = [
  {
    environmentId: EnvironmentId.make("test-environment"),
    label: "Test environment",
    isPending: false,
    canReadDiagnostics: true,
    error: null,
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-08-11T12:37:00.000Z",
      sinceDay: UsageDay.make("2026-08-10"),
      untilDay: UsageDay.make("2026-08-11"),
      timeZone: "UTC",
      buckets: [],
      sources: [],
      pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 1,
    },
  },
];

beforeEach(() => {
  testState.useUsage.mockReturnValue({
    all: mergeUsage([], USAGE_CONTRACT_VERSION),
    merged: {
      ...mergeUsage([], USAGE_CONTRACT_VERSION),
      models: modelTotals,
      hourly: [
        {
          day: "2026-08-10",
          hourStart: "2026-08-10T13:37:00.000Z",
          costUsd: 13,
          totalTokens: 13_000,
          byProvider: providerTotals(7, 6),
        },
        {
          day: "2026-08-11",
          hourStart: "2026-08-11T11:37:00.000Z",
          costUsd: 11,
          totalTokens: 11_000,
          byProvider: providerTotals(6, 5),
        },
      ],
    },

    environments,
    selectedEnvironments: environments,
    isPending: false,
    shown: null,
    isPartial: false,
    refresh: vi.fn(),
  });
});

describe("UsagePage Escape navigation", () => {
  let renderer: Root;
  let container: HTMLDivElement;
  let back: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    testState.navigate.mockClear();
    testState.canGoBack = true;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    renderer = createRoot(container);
    await act(() => {
      renderer.render(<UsagePage />);
    });
  });

  afterEach(async () => {
    await act(() => renderer.unmount());
    container.remove();
    back.mockRestore();
    vi.unstubAllGlobals();
  });

  function escape(properties: { repeat?: boolean; isComposing?: boolean } = {}) {
    return new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      ...properties,
    });
  }

  it("returns to the previous page on Escape", () => {
    document.body.dispatchEvent(escape());
    expect(back).toHaveBeenCalledOnce();
    expect(testState.navigate).not.toHaveBeenCalled();
  });

  it("returns home when there is no previous app page", async () => {
    testState.canGoBack = false;
    await act(() => renderer.render(<UsagePage />));

    document.body.dispatchEvent(escape());
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/" });
    expect(back).not.toHaveBeenCalled();
  });

  it("closes the environment menu before Escape navigates back", async () => {
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="menu-trigger"]')!;
    await act(() => trigger.click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    await act(() => {
      document.activeElement!.dispatchEvent(escape());
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(back).not.toHaveBeenCalled();

    document.body.dispatchEvent(escape());
    expect(back).toHaveBeenCalledOnce();
  });

  it.each([{ repeat: true }, { isComposing: true }])("ignores Escape with %j", (properties) => {
    document.body.dispatchEvent(escape(properties));
    expect(back).not.toHaveBeenCalled();
    expect(testState.navigate).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
