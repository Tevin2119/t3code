import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseSeatSettings, type SeatSettings } from "../../lib/delivery";
import { SeatSettingsPanel } from "./SeatSettingsPanel";

type Props = Record<string, unknown>;
const mock = vi.hoisted(() => ({
  pickers: [] as Array<Record<string, unknown>>,
  traits: [] as Array<Record<string, unknown>>,
}));
const entries = [
  {
    instanceId: "claudeAgent",
    driverKind: "claudeAgent",
    displayName: "Claude",
    isDefault: true,
    enabled: true,
    installed: true,
    isAvailable: true,
    models: [{ slug: "claude-opus-4", name: "Claude Opus 4" }],
  },
  {
    instanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    isDefault: true,
    enabled: true,
    installed: true,
    isAvailable: true,
    models: [{ slug: "gpt-5", name: "GPT-5" }],
  },
];

vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  T: (props: { children: ReactNode }) => <>{props.children}</>,
}));
vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: () => ({}) }));
vi.mock("../../state/environments", () => ({ useEnvironmentProviders: () => new Map() }));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: { refreshProviders: {} },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../modelSelection", () => ({ getCustomModelOptionsByInstance: () => new Map() }));
vi.mock("../../providerInstances", () => ({
  deriveProviderInstanceEntries: () => entries,
  applyProviderInstanceSettings: (value: unknown) => value,
  sortProviderInstanceEntries: (value: unknown) => value,
  defaultModelOfProviderInstanceEntry: (entry: { models: Array<{ slug: string }> }) =>
    entry.models[0]?.slug,
}));
vi.mock("./OrchestratorSeatGlyphs", () => ({ HarnessTile: () => null }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: (props: { children: ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { children?: ReactNode }) => <>{props.children}</>,
  TooltipPopup: (props: { children: ReactNode }) => <span data-tip>{props.children}</span>,
}));
vi.mock("../ui/switch", () => ({ Switch: () => null }));
vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: (props: Props) => {
    mock.pickers.push(props);
    return null;
  },
}));
// The traits menu as the model describes it: its reasoning option, filled with the model's
// default when the seat sets none, and a context window.
vi.mock("../chat/TraitsPicker", () => ({
  TraitsPicker: (props: Props) => {
    mock.traits.push(props);
    return null;
  },
  getTraitsSectionVisibility: (input: {
    provider: string;
    modelOptions: ReadonlyArray<{ id: string; value: string }>;
  }) => {
    const id = input.provider === "codex" ? "reasoningEffort" : "effort";
    return {
      descriptors: [
        {
          id,
          label: "Reasoning",
          type: "select",
          options: [{ id: "medium", label: "Medium", isDefault: true }],
          currentValue: input.modelOptions.find((option) => option.id === id)?.value ?? "medium",
        },
        {
          id: "contextWindow",
          label: "Context window",
          type: "select",
          options: [{ id: "200k", label: "200k", isDefault: true }],
          currentValue: "200k",
        },
      ],
    };
  },
}));

const seat = (raw: Record<string, unknown>): SeatSettings =>
  parseSeatSettings({ role: "build", access: "full", ...raw } as never);

const settings = [
  seat({
    seat: "builder",
    title: "Builder",
    harness: "claude",
    now: { harness: "claude", model: "claude-opus-4", reasoning: "high", access: "full" },
    may: { model: true, reasoning: ["low", "medium", "high", "max"], access: ["full"] },
  }),
  seat({
    seat: "reviewer",
    title: "Reviewer",
    harness: "codex",
    now: { harness: "codex", model: "gpt-5", reasoning: null, access: "full" },
    may: { model: true, reasoning: ["low", "medium", "high"], access: ["full", "read-only"] },
  }),
  // A harness that takes no reasoning setting keeps the fixed reading, with no traits menu.
  seat({
    seat: "qa",
    title: "QA",
    harness: "claude",
    now: { harness: "claude", model: "claude-opus-4", reasoning: null, access: "full" },
    may: { model: true, reasoning: [], access: ["full"] },
  }),
];

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");

let renderer: ReactTestRenderer;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mock.pickers = [];
  mock.traits = [];
});
afterEach(async () => {
  await act(() => renderer?.unmount());
});

async function render(onChange: (seat: string, choice: unknown) => void) {
  await act(() => {
    renderer = create(
      <SeatSettingsPanel
        environmentId={"env-1" as never}
        settings={settings}
        chosen={{}}
        onChange={onChange}
      />,
    );
  });
  return renderer.root;
}

const traitsOf = (seatId: string) => {
  const titles: Record<string, string> = { builder: "claudeAgent", reviewer: "codex" };
  return mock.traits.findLast((props) => props.instanceId === titles[seatId])!;
};

describe("SeatSettingsPanel", () => {
  it("gives each seat the team chat's model picker and traits menu, on its own harness", async () => {
    const root = await render(() => {});
    expect(
      mock.pickers.map((props) => [props.triggerAriaLabel, props.activeInstanceId, props.model]),
    ).toEqual([
      ["Harness and model for Builder", "claudeAgent", "claude-opus-4"],
      ["Harness and model for Reviewer", "codex", "gpt-5"],
      ["Harness and model for QA", "claudeAgent", "claude-opus-4"],
    ]);
    // Reasoning is picked from the model's levels; a seat with none set leaves the model's default.
    expect(
      mock.traits.map((props) => [
        props.provider,
        props.instanceId,
        props.model,
        props.modelOptions,
        props.allowPromptInjectedEffort,
      ]),
    ).toEqual([
      ["claudeAgent", "claudeAgent", "claude-opus-4", [{ id: "effort", value: "high" }], false],
      ["codex", "codex", "gpt-5", [], false],
    ]);
    expect(
      root
        .findAll((node) => typeof node.props["data-seat-traits"] === "string")
        .map((node) => node.props["data-seat-traits"]),
    ).toEqual(["builder", "reviewer"]);
    // The engine's limit is said where the controls are.
    const limits = root.find((node) => node.props["data-seat-engine-limits"] === true);
    expect(text(limits)).toContain("no context-window field");
  });

  it("saves the reasoning level picked for a seat, and never a context window", async () => {
    const onChange = vi.fn();
    await render(onChange);

    // A context window alone is not saved: the engine's seat settings have no field for it.
    await act(() =>
      (traitsOf("reviewer").onModelOptionsChange as (next: unknown) => void)([
        { id: "reasoningEffort", value: "medium" },
        { id: "contextWindow", value: "1m" },
      ]),
    );
    expect(onChange).not.toHaveBeenCalled();

    await act(() =>
      (traitsOf("reviewer").onModelOptionsChange as (next: unknown) => void)([
        { id: "reasoningEffort", value: "high" },
        { id: "contextWindow", value: "200k" },
      ]),
    );
    expect(onChange).toHaveBeenLastCalledWith("reviewer", { reasoning: "high" });

    await act(() =>
      (traitsOf("builder").onModelOptionsChange as (next: unknown) => void)([
        { id: "effort", value: "max" },
      ]),
    );
    expect(onChange).toHaveBeenLastCalledWith("builder", { reasoning: "max" });
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
