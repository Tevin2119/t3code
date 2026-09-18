import { expect, it } from "@effect/vitest";

import { parsePiAuthCheck, parsePiModelsOutput } from "./PiProvider.ts";

// Captured verbatim from `pi --list-models kimi` on pi 0.85.1. Columns are
// aligned with runs of spaces and the rows carry trailing padding.
const MODELS_OUTPUT = [
  "provider     model                      context  max-out  thinking  images",
  "kimi-coding  k3                         1.0M     131.1K   yes       yes   ",
  "kimi-coding  k3-256k                    262.1K   131.1K   yes       yes   ",
  "kimi-coding  kimi-for-coding            262.1K   32.8K    yes       yes   ",
  "kimi-coding  kimi-for-coding-highspeed  262.1K   32.8K    yes       yes   ",
].join("\n");

it("reads provider-qualified model slugs from the CLI table", () => {
  const models = parsePiModelsOutput(MODELS_OUTPUT);

  expect(models.map((model) => model.slug)).toEqual([
    "kimi-coding/k3",
    "kimi-coding/k3-256k",
    "kimi-coding/kimi-for-coding",
    "kimi-coding/kimi-for-coding-highspeed",
  ]);
  expect(models[0]).toMatchObject({ name: "k3", subProvider: "kimi-coding", isCustom: false });
});

it("drops the header row rather than reading it as a model", () => {
  const models = parsePiModelsOutput(MODELS_OUTPUT);

  expect(models.some((model) => model.slug === "provider/model")).toBe(false);
});

it("returns nothing when the CLI printed no rows", () => {
  expect(parsePiModelsOutput("")).toEqual([]);
  expect(parsePiModelsOutput("provider  model  context")).toEqual([]);
});

it("reads a ready provider as authenticated with its auth type", () => {
  expect(
    parsePiAuthCheck('{"status":"ready","provider":"kimi-coding","authType":"oauth"}'),
  ).toEqual({ status: "authenticated", type: "oauth", label: "Moonshot account" });
});

it("reads every non-ready verdict as signed out", () => {
  expect(
    parsePiAuthCheck(
      '{"status":"not_ready","provider":"moonshotai","reason":"provider_not_found"}',
    ),
  ).toEqual({ status: "unauthenticated" });
  expect(
    parsePiAuthCheck(
      '{"status":"not_ready","provider":"kimi-coding","reason":"credentials_not_configured"}',
    ),
  ).toEqual({ status: "unauthenticated" });
});

it("reports unknown rather than signed out when the output is not JSON", () => {
  expect(parsePiAuthCheck("pi: unknown provider")).toBeUndefined();
});
