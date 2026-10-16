import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));

import { PROVIDER_LABEL, PROVIDER_ORDER, useProviderColors } from "./usageProviders";

describe("mobile usage provider series", () => {
  it("renders each provider once with a label and color", () => {
    expect(new Set(PROVIDER_ORDER).size).toBe(PROVIDER_ORDER.length);
    const colors = useProviderColors();
    for (const provider of PROVIDER_ORDER) {
      expect(PROVIDER_LABEL[provider]).toBeTruthy();
      expect(colors[provider]).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(PROVIDER_ORDER).toContain("pi");
  });
});
