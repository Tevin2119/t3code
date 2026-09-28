import { describe, expect, it } from "vite-plus/test";

import { parseSeatSettings } from "./delivery";
import {
  describeSeatValues,
  driverOfHarness,
  entriesForSeat,
  entryForHarness,
  harnessOfDriver,
  seatValues,
  sharePercentages,
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
    expect(seatValues(lead.now, {})).toEqual(lead.now);
    expect(seatValues(lead.now, { model: "gpt-6-sol" })).toEqual({
      harness: "codex",
      model: "gpt-6-sol",
      reasoning: "high",
      access: "full",
    });
  });

  it("drops what was set for the harness a seat left", () => {
    expect(seatValues(lead.now, { harness: "claude", model: "claude-opus-5-5" })).toEqual({
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
      describeSeatValues({ harness: "dsh", model: null, reasoning: null, access: "read-only" }),
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
