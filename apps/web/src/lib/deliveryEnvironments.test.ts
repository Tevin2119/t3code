import { describe, expect, it } from "vite-plus/test";
import {
  environmentWorkspaceLabel,
  groupWorkspaceEnvironments,
  matchesEnvironmentSearch,
} from "./deliveryEnvironments";

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

  it("groups paired profiles by explicit machine identity, not by matching labels", () => {
    const profile = (
      environmentId: string,
      machineId: string,
      profileId: string,
      profileLabel: string,
    ) => ({
      environmentId,
      label: "Saved name",
      displayUrl: null,
      serverConfig: {
        environment: { workspace: { machineId, machineLabel: "Mac", profileId, profileLabel } },
      },
    });
    const main = profile("main-server", "mac-1", "main", "Main");
    const pm = profile("pm-server", "mac-1", "pm", "PolyMania");
    const other = profile("other-server", "mac-2", "main", "Main");
    const legacy = { environmentId: "legacy", label: "Mac", displayUrl: null };
    expect(
      groupWorkspaceEnvironments([main, pm, other, legacy], "").map((group) =>
        group.environments.map((item) => item.environmentId),
      ),
    ).toEqual([["main-server", "pm-server"], ["other-server"], ["legacy"]]);
    expect(groupWorkspaceEnvironments([main, pm], "mac polymania")[0]?.environments).toEqual([pm]);
    expect(environmentWorkspaceLabel(main)).toBe("Mac / Main");
    expect(environmentWorkspaceLabel(legacy)).toBe("Mac");
  });
});
