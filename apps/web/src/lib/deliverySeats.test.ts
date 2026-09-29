import { describe, expect, it } from "vite-plus/test";

import { parseSeatSettings, type SeatSettings, type SeatSettingValues } from "./delivery";
import {
  describeSeatValues,
  driverOfHarness,
  entriesForSeat,
  entryForHarness,
  harnessOfDriver,
  seatForThread,
  seatOverrides,
  seatValues,
  sharePercentages,
  takeOverFor,
  withTeamModels,
} from "./deliverySeats";

const entries = [
  { instanceId: "codex", driverKind: "codex", isDefault: true },
  { instanceId: "claudeAgent", driverKind: "claudeAgent", isDefault: true },
  { instanceId: "claude-work", driverKind: "claudeAgent", isDefault: false },
  { instanceId: "deepseek", driverKind: "deepseek", isDefault: true },
  { instanceId: "cursor", driverKind: "cursor", isDefault: true },
];

const lead = parseSeatSettings({
  seat: "lead",
  title: "Lead developer",
  role: "team-lead",
  harness: "codex",
  defined: { harness: "codex", model: "gpt-6-astra", reasoning: null, access: "full" },
  now: { harness: "codex", model: "gpt-6-astra", reasoning: "high", access: "full" },
  models: ["gpt-6-astra", "gpt-6-sol"],
  may: { harness: ["claude", "codex", "dsh"], model: true, reasoning: [], access: ["full"] },
});

describe("harnesses and the catalog", () => {
  it("names a harness the engine's way and back", () => {
    expect(harnessOfDriver("claudeAgent")).toBe("claude");
    expect(harnessOfDriver("deepseek")).toBe("dsh");
    expect(harnessOfDriver("cursor")).toBeNull();
    expect(driverOfHarness("dsh")).toBe("deepseek");
    expect(driverOfHarness("abacus")).toBeNull();
  });

  it("offers a seat the harnesses the engine knows and the team allows", () => {
    expect(entriesForSeat(entries, lead).map((entry) => entry.instanceId)).toEqual([
      "codex",
      "claudeAgent",
      "claude-work",
      "deepseek",
    ]);
    // Where the team does not allow the harness to change, only its own is offered.
    const fixed = { ...lead, may: { ...lead.may, harness: [] } };
    expect(entriesForSeat(entries, fixed).map((entry) => entry.instanceId)).toEqual(["codex"]);
  });

  it("shows a harness as its first set-up", () => {
    expect(entryForHarness(entries, "claude")?.instanceId).toBe("claudeAgent");
    expect(entryForHarness(entries, "kimi")).toBeNull();
    expect(entryForHarness(entries, null)).toBeNull();
  });

  it("puts the models the team names first, and keeps one the catalog does not list", () => {
    const listed = [
      { slug: "gpt-6-luna", name: "GPT-6 Luna" },
      { slug: "gpt-6-sol", name: "GPT-6 Sol" },
    ];
    expect(
      withTeamModels(listed, lead.models, (slug) => ({ slug, name: slug })).map(
        (option) => option.slug,
      ),
    ).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);
    expect(withTeamModels(listed, [], (slug) => ({ slug, name: slug }))).toBe(listed);
  });
});

describe("what a seat runs on", () => {
  it("lays a choice over the team default", () => {
    expect(seatValues(lead.now, {})).toEqual({ ...lead.now, active: "on" });
    // A seat that is switched off keeps what is set for it.
    expect(seatValues(lead.now, { active: "off", model: "gpt-6-sol" })).toEqual({
      active: "off",
      harness: "codex",
      model: "gpt-6-sol",
      reasoning: "high",
      access: "full",
    });
  });

  it("drops what was set for the harness a seat left", () => {
    expect(seatValues(lead.now, { harness: "claude", model: "claude-opus-5-5" })).toEqual({
      active: "on",
      harness: "claude",
      model: "claude-opus-5-5",
      reasoning: null,
      access: null,
    });
    expect(seatValues(lead.now, { harness: "dsh" }).model).toBeNull();
  });

  it("says it in one line", () => {
    expect(describeSeatValues(lead.now)).toBe("Codex, gpt-6-astra, high reasoning");
    expect(
      describeSeatValues({
        active: "on",
        harness: "dsh",
        model: null,
        reasoning: null,
        access: "read-only",
      }),
    ).toBe("DeepSeek, its own model, read-only access");
  });

  it("shows shares as parts of a hundred", () => {
    expect(sharePercentages({ developer: 3, "developer-2": 1 })).toEqual({
      developer: 75,
      "developer-2": 25,
    });
    expect(sharePercentages({ developer: 0, "developer-2": 0 })).toEqual({
      developer: 0,
      "developer-2": 0,
    });
  });
});

describe("how much of a seat is taken over", () => {
  const seat = { seat: "developer-2", harness: "pi", model: "m", reasoning: null, access: "full" };

  it("takes the first seat of a draft over whole", () => {
    expect(takeOverFor(null, seat)).toBe("inherit");
  });

  it("takes a seat over whole when the team or the role changed", () => {
    expect(takeOverFor("rnd|researcher|pi|m||full", seat)).toBe("inherit");
  });

  it("leaves the model a person picked on another harness", () => {
    expect(takeOverFor("development|qa-validate|kimi|||full", seat)).toBe("inherit-level");
  });
});

describe("what a thread takes over from its seat", () => {
  const values = (over: Partial<SeatSettingValues>): SeatSettingValues => ({
    active: "on",
    harness: null,
    model: null,
    reasoning: null,
    access: null,
    ...over,
  });
  const seat = (over: Partial<SeatSettings>): SeatSettings =>
    ({
      seat: "lead",
      title: "Lead",
      role: "research-lead",
      duties: [],
      harness: "claude",
      provider: "anthropic",
      defined: values({ harness: "claude" }),
      now: values({
        harness: "claude",
        model: "claude-fable-5-1",
        reasoning: "high",
        access: "full",
      }),
      saved: {},
      models: [],
      may: { harness: [], model: true, reasoning: [], access: [] },
      byHarness: {},
      why: values({}),
      set: {},
      effective: values({}),
      ...over,
    }) as SeatSettings;

  it("takes the seat the harness holds in the role, as the team has it now", () => {
    expect(seatForThread([seat({})], "claude", "research-lead")).toEqual({
      seat: "lead",
      harness: "claude",
      model: "claude-fable-5-1",
      reasoning: "high",
      access: "full",
    });
  });

  it("follows a seat the saved defaults moved to another harness", () => {
    const moved = seat({ now: values({ harness: "codex", model: "gpt-6-luna" }) });
    expect(seatForThread([moved], "codex", "research-lead").seat).toBe("lead");
    expect(seatForThread([moved], "claude", "research-lead").seat).toBeNull();
  });

  it("gives a role taken by choice the model of a seat on the harness, and no level", () => {
    expect(seatForThread([seat({})], "claude", "critic")).toEqual({
      seat: null,
      harness: "claude",
      model: "claude-fable-5-1",
      reasoning: null,
      access: "full",
    });
  });

  it("finds no override in a thread that runs as its seat does", () => {
    const mine = seatForThread([seat({})], "claude", "research-lead");
    expect(
      seatOverrides(mine, {
        model: "claude-fable-5-1",
        reasoning: "high",
        runtimeMode: "full-access",
      }),
    ).toEqual([]);
  });

  it("names each setting that is not what the seat has", () => {
    const mine = seatForThread([seat({})], "claude", "research-lead");
    expect(
      seatOverrides(mine, {
        model: "claude-sonnet-5-5",
        reasoning: null,
        runtimeMode: "approval-required",
      }),
    ).toEqual([
      { setting: "model", seat: "claude-fable-5-1", chosen: "claude-sonnet-5-5" },
      { setting: "reasoning", seat: "high", chosen: "harness default" },
      { setting: "access", seat: "full access", chosen: "approval-required" },
    ]);
  });

  it("holds full access against a seat that is restricted", () => {
    const restricted = seatForThread(
      [seat({ now: values({ harness: "claude", access: "read-only" }) })],
      "claude",
      "research-lead",
    );
    expect(
      seatOverrides(restricted, { model: null, reasoning: null, runtimeMode: "full-access" }),
    ).toEqual([{ setting: "access", seat: "read-only access", chosen: "full-access" }]);
    expect(
      seatOverrides(restricted, { model: null, reasoning: null, runtimeMode: "approval-required" }),
    ).toEqual([]);
  });
});
