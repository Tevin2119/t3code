import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  firstFreeFavorite,
  type LimitedSeatFacts,
  limitedSeatCandidates,
  modelAccountFamily,
  seatLimit,
} from "./limitedSeat.ts";

const now = Date.parse("2026-11-22T12:00:00.000Z");
const later = "2026-11-22T17:00:00.000Z";
const id = ProviderInstanceId.make;
const projectId = ProjectId.make("project");

function provider(
  instanceId: string,
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: id(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-22T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const exhausted = {
  checkedAt: "2026-11-22T11:00:00.000Z",
  windows: [{ id: "primary", label: "5 hours", usedPercent: 100, resetsAt: later }],
} as NonNullable<ServerProvider["usageLimits"]>;

const favorite = (instanceId: string, model: string) => ({ provider: id(instanceId), model });
const seat = (instanceId: string, model: string) => ({ instanceId: id(instanceId), model });

function facts(
  overrides: Partial<Omit<LimitedSeatFacts, "settings">> & {
    readonly favorites?: LimitedSeatFacts["settings"]["favorites"];
  } = {},
): LimitedSeatFacts {
  const providers = overrides.providers ?? [
    provider("claude", "claudeAgent", { usageLimits: exhausted }),
    provider("codex", "codex"),
    provider("kimi", "kimi"),
    provider("deepseek", "deepseek"),
  ];
  return {
    now,
    projectId,
    threadLimits: [],
    ...overrides,
    providers,
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: Object.fromEntries(
        providers.map((entry) => [entry.instanceId, { driver: entry.driver, enabled: true }]),
      ),
      favorites: overrides.favorites ?? [
        favorite("claude", "claude-opus"),
        favorite("codex", "gpt-astra"),
        favorite("kimi", "kimi-k3"),
        favorite("deepseek", "deepseek-v4"),
      ],
    },
  };
}

const limited = seat("claude", "claude-fable");
const pick = (input: Partial<Parameters<typeof limitedSeatCandidates>[0]> = {}) =>
  firstFreeFavorite(limitedSeatCandidates({ facts: facts(), limited, inUse: [], ...input }));

describe("the swap pool for a limited seat", () => {
  it("reads a limit from the provider's windows and from a turn that failed on it", () => {
    expect(seatLimit(facts(), limited)).toMatchObject({ resetAt: later });
    expect(seatLimit(facts(), seat("codex", "gpt-astra"))).toBeNull();
    const failed = facts({ threadLimits: [{ ...seat("codex", "gpt-astra"), resetAt: later }] });
    expect(seatLimit(failed, seat("codex", "gpt-astra"))).toMatchObject({ resetAt: later });
    // A window that has already reset no longer limits anything.
    const reset = facts({
      threadLimits: [{ ...seat("codex", "gpt-astra"), resetAt: "2026-11-22T11:59:00.000Z" }],
    });
    expect(seatLimit(reset, seat("codex", "gpt-astra"))).toBeNull();
  });

  it("takes the first favorite in the person's order, and never a model outside Favorites", () => {
    expect(pick()).toEqual(seat("codex", "gpt-astra"));
    expect(pick({ facts: facts({ favorites: [] }) })).toBeNull();
  });

  it.each([
    {
      name: "one whose provider is not ready",
      providers: { codex: { status: "error" as const } },
      skip: "unavailable",
    },
    {
      name: "one whose provider is signed out",
      providers: { codex: { auth: { status: "unauthenticated" as const } } },
      skip: "unavailable",
    },
    {
      name: "one that is itself usage-limited",
      providers: { codex: { usageLimits: exhausted } },
      skip: "limited",
    },
  ])("skips $name", ({ providers, skip }) => {
    const base = facts();
    const candidates = limitedSeatCandidates({
      facts: {
        ...base,
        providers: base.providers.map((entry) => ({
          ...entry,
          ...(providers as Record<string, Partial<ServerProvider>>)[entry.instanceId],
        })),
      },
      limited,
      inUse: [],
    });
    expect(candidates.find((entry) => entry.instanceId === "codex")?.skip).toBe(skip);
    expect(firstFreeFavorite(candidates)).toEqual(seat("kimi", "kimi-k3"));
  });

  it("skips a favorite turned off for the project", () => {
    const base = facts();
    const candidates = limitedSeatCandidates({
      facts: {
        ...base,
        settings: {
          ...base.settings,
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [id("codex")]: { enabled: false } } },
          },
        },
      },
      limited,
      inUse: [],
    });
    expect(candidates[1]?.skip).toBe("unavailable");
  });

  it("skips the limited model's own account and its provider family", () => {
    const candidates = limitedSeatCandidates({
      facts: facts({
        providers: [
          provider("claude", "claudeAgent", { usageLimits: exhausted }),
          // Another harness on the same vendor, and a second sign-in to the same harness.
          provider("pi", "pi"),
          provider("claude-2", "claudeAgent"),
          provider("codex", "codex"),
        ],
        favorites: [
          favorite("claude", "claude-opus"),
          favorite("pi", "anthropic/claude-opus"),
          favorite("claude-2", "claude-opus"),
          favorite("codex", "gpt-astra"),
        ],
      }),
      limited,
      inUse: [],
    });
    // The limited instance's own window already rules out its other models.
    expect(candidates.map((entry) => entry.skip)).toEqual([
      "limited",
      "same-account",
      "same-account",
      null,
    ]);
  });

  it("skips a model another seat or the lead already runs", () => {
    expect(pick({ inUse: [seat("codex", "gpt-astra")] })).toEqual(seat("kimi", "kimi-k3"));
  });

  it("keeps a QA seat off the builder's model, on any account", () => {
    const candidates = limitedSeatCandidates({
      facts: facts(),
      limited,
      inUse: [],
      builderModels: [seat("codex-other", "gpt-astra")],
    });
    expect(candidates[1]?.skip).toBe("not-independent");
    expect(firstFreeFavorite(candidates)).toEqual(seat("kimi", "kimi-k3"));
  });

  it("finds none free when every favorite is skipped", () => {
    expect(
      pick({
        inUse: [
          seat("codex", "gpt-astra"),
          seat("kimi", "kimi-k3"),
          seat("deepseek", "deepseek-v4"),
        ],
      }),
    ).toBeNull();
  });

  it("names the family by the model's vendor, then by the harness", () => {
    expect(modelAccountFamily("pi", "openai/gpt-6-astra")).toBe("openai");
    expect(modelAccountFamily("codex", "astra")).toBe("openai");
    expect(modelAccountFamily("opencode", "zai-coding-plan/glm-5.3")).toBe("zhipu");
    expect(modelAccountFamily("opencode", "fireworks/llama")).toBe("fireworks");
    expect(modelAccountFamily("hermes", "default")).toBe("driver:hermes");
  });
});
