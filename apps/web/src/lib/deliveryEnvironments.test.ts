import { describe, expect, it } from "vite-plus/test";
import { matchesEnvironmentSearch } from "./deliveryEnvironments";

describe("board environment search", () => {
  const mac = { label: "Tevin's MacBook Pro", displayUrl: "http://100.124.197.108:16231" };

  it("matches machine names case-insensitively and ignores outer whitespace", () => {
    expect(matchesEnvironmentSearch(mac, "  MACBOOK pro  ")).toBe(true);
    expect(matchesEnvironmentSearch(mac, "windows")).toBe(false);
  });

  it("matches a saved address and requires every search word", () => {
    expect(matchesEnvironmentSearch(mac, "macbook 16231")).toBe(true);
    expect(matchesEnvironmentSearch(mac, "macbook 4321")).toBe(false);
  });

  it("includes all environments for an empty search, including addressless ones", () => {
    expect(matchesEnvironmentSearch(mac, " ")).toBe(true);
    expect(matchesEnvironmentSearch({ label: "Cloud machine", displayUrl: null }, "cloud")).toBe(
      true,
    );
    expect(matchesEnvironmentSearch({ label: "Cloud machine", displayUrl: null }, "macbook")).toBe(
      false,
    );
  });
});
