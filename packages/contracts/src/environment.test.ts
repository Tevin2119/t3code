import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor, sameWorkspaceProfile } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("keeps legacy environments unscoped and preserves explicit workspace metadata", () => {
    expect(decodeDescriptor(descriptor).workspace).toBeUndefined();
    const workspace = {
      machineId: "mac",
      machineLabel: "Mac",
      profileId: "main",
      profileLabel: "Main",
    };
    expect(decodeDescriptor({ ...descriptor, workspace }).workspace).toEqual(workspace);
    expect(() =>
      decodeDescriptor({ ...descriptor, workspace: { ...workspace, profileId: "../pm" } }),
    ).toThrow();
  });

  it("allows balancing within a profile, never into another or an unscoped environment", () => {
    const main = { machineId: "mac", machineLabel: "Mac", profileId: "main", profileLabel: "Main" };
    expect(sameWorkspaceProfile(main, { ...main, machineId: "windows" })).toBe(false);
    expect(
      sameWorkspaceProfile(
        { ...main, allocationScope: "personal-owner" },
        { ...main, machineId: "windows", allocationScope: "personal-owner" },
      ),
    ).toBe(true);
    expect(
      sameWorkspaceProfile(
        { ...main, allocationScope: "personal-owner" },
        { ...main, machineId: "windows", allocationScope: "work-owner" },
      ),
    ).toBe(false);
    expect(sameWorkspaceProfile(main, { ...main, profileId: "pm" })).toBe(false);
    expect(sameWorkspaceProfile(main, undefined)).toBe(false);
    expect(sameWorkspaceProfile(undefined, main)).toBe(false);
    expect(sameWorkspaceProfile(undefined, undefined)).toBe(true);
  });

  it("keeps settled cleanup optional alongside current worktree capabilities", () => {
    expect(decodeDescriptor(descriptor).capabilities.settledWorktreeCleanup).toBeUndefined();
    const capabilities = {
      settledWorktreeCleanup: true,
      storageCleanupRun: true,
      projectWorktreeCleanup: true,
      worktreesDirectory: true,
      threadAutoSettlementScope: true,
    };
    expect(decodeDescriptor({ ...descriptor, capabilities }).capabilities).toMatchObject(
      capabilities,
    );
  });

  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [{ kind: "npx" }, { kind: "npm-global", prefix: "/opt/node" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    for (const installation of [{ kind: "future-manager" }, { kind: "npm-global" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });
});
