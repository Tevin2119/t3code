import { HERMES_DEFAULT_MODEL } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import {
  hermesModelsFromRuntimeConfig,
  parseHermesAuthStatus,
  parseHermesConfigValue,
} from "./HermesProvider.ts";

// Captured verbatim from `hermes auth status <provider>` on Hermes Agent 0.21.1.
it("reads the sign-in verdict the CLI prints", () => {
  expect(parseHermesAuthStatus("deepseek: logged in\n")).toBe(true);
  expect(parseHermesAuthStatus("nvidia: logged out\n")).toBe(false);
  expect(parseHermesAuthStatus("")).toBe(false);
});

it("takes the first printed line as the config value", () => {
  expect(parseHermesConfigValue("\ndeepseek\n")).toBe("deepseek");
  expect(parseHermesConfigValue("None\n")).toBeUndefined();
  expect(parseHermesConfigValue("   \n")).toBeUndefined();
});

it("publishes the configured pair under the default alias", () => {
  const models = hermesModelsFromRuntimeConfig({
    provider: "deepseek",
    model: "deepseek-v4-pro",
  });

  expect(models).toEqual([
    {
      slug: "deepseek:deepseek-v4-pro",
      name: "deepseek-v4-pro",
      isCustom: false,
      isDefault: true,
      aliases: [HERMES_DEFAULT_MODEL],
      capabilities: models[0]?.capabilities,
    },
  ]);
});

it("offers the default alias itself when Hermes reports no configuration", () => {
  expect(hermesModelsFromRuntimeConfig(undefined).map((model) => model.slug)).toEqual([
    HERMES_DEFAULT_MODEL,
  ]);
});
