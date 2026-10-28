import { describe, expect, it } from "vite-plus/test";
import { DeploymentActionInput, DeploymentProjectInput, DeliveryPath } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  deploymentRequestBody,
  deploymentActions,
  parseDeployments,
  parseDeploymentCommands,
} from "./deployments";

const isProject = Schema.is(DeploymentProjectInput);
const isAction = Schema.is(DeploymentActionInput);
const isPath = Schema.is(DeliveryPath);
const snapshot = {
  version: 1,
  projects: [],
  candidates: [],
  repositories: [],
  capabilities: { engine: true, command: false },
};
describe("deployment contract", () => {
  it("distinguishes an empty board from unsupported or malformed engine data", () => {
    expect(parseDeployments(snapshot)?.projects).toEqual([]);
    for (const value of [
      null,
      {},
      { ...snapshot, version: 2 },
      { ...snapshot, capabilities: {} },
      { ...snapshot, candidates: [{}] },
    ]) {
      expect(parseDeployments(value)).toBeNull();
    }
  });
  it("rejects branch names masquerading as pinned revisions and unknown states", () => {
    const candidate = {
      id: "release-1",
      projectId: "project-1",
      commit: "a".repeat(40),
      baseCommit: null,
      state: "merged",
      createdAt: "2026-10-28T00:00:00Z",
      updatedAt: "2026-10-28T00:00:00Z",
      evidence: [],
      events: [],
    };
    expect(parseDeployments({ ...snapshot, candidates: [candidate] })?.candidates).toHaveLength(1);
    expect(
      parseDeployments({ ...snapshot, candidates: [{ ...candidate, commit: "main" }] }),
    ).toBeNull();
    expect(
      parseDeployments({ ...snapshot, candidates: [{ ...candidate, state: "unknown" }] }),
    ).toBeNull();
  });
  it("validates command argument arrays without shell splitting", () => {
    expect(parseDeploymentCommands("").commands).toBeNull();
    for (const text of [
      "{}",
      '{"qualify":"npm test"}',
      '{"qualify":[],"deploy":["deploy"],"verify":["verify"]}',
      "not json",
    ])
      expect(parseDeploymentCommands(text).problem).not.toBeNull();
    const commands = {
      setup: ["npm", "ci"],
      qualify: ["npm", "test"],
      deploy: ["deploy", "argument with spaces"],
      verify: ["verify"],
    };
    expect(parseDeploymentCommands(JSON.stringify(commands)).commands).toEqual(commands);
  });
  it("requires an actor, the direct approval key, and known mode and action for mutations", () => {
    const project = {
      repository: "repo",
      branch: "main",
      environment: "production",
      mode: "manual",
      adapter: "engine",
      by: "Sam",
      key: "passphrase",
    };
    expect(isProject(project)).toBe(true);
    expect(isProject({ ...project, mode: "full-auto" })).toBe(false);
    expect(isProject({ ...project, mode: "full-auto", confirmed: true })).toBe(true);
    expect(isProject({ ...project, adapter: "command", environment: "staging" })).toBe(true);
    expect(isProject({ ...project, environment: "staging" })).toBe(false);
    expect(isProject({ ...project, adapter: "command", environment: "development" })).toBe(true);
    expect(isProject({ ...project, adapter: "command", environment: "qa.eu" })).toBe(true);
    expect(isProject({ ...project, adapter: "command", environment: "invalid space" })).toBe(false);
    expect(isProject({ ...project, mode: "automatic" })).toBe(false);
    expect(isProject({ ...project, key: undefined })).toBe(false);
    expect(isProject({ ...project, mode: "full-auto", confirmed: true, key: "" })).toBe(false);
    expect(isAction({ action: "deploy", by: "", key: "passphrase" })).toBe(false);
    expect(isAction({ action: "deploy", by: "Sam" })).toBe(false);
    expect(isAction({ action: "deploy", by: "Sam", key: "passphrase" })).toBe(true);
  });
  it("decodes dependency selections and refuses unknown mutation paths", () => {
    expect(
      deploymentRequestBody("/api/deployments/candidates/release-1/dependencies", {
        dependencies: ["release-2"],
        by: "Sam",
        key: "passphrase",
      }),
    ).toEqual({ dependencies: ["release-2"], by: "Sam", key: "passphrase" });
    expect(() =>
      deploymentRequestBody("/api/deployments/candidates/release-1/dependencies", {
        dependencies: ["../invalid"],
        by: "Sam",
        key: "passphrase",
      }),
    ).toThrow();
    expect(() => deploymentRequestBody("/api/tasks", {})).toThrow();
  });
  it("accepts repositories whose default branch is unknown", () => {
    expect(
      parseDeployments({
        ...snapshot,
        repositories: [
          {
            id: "repo",
            title: "Repo",
            path: "/repo",
            defaultBase: null,
            branches: [],
            kind: "git",
            ok: true,
          },
        ],
      }),
    ).not.toBeNull();
  });
  it("relays deployment paths while refusing traversal and external URLs", () => {
    for (const path of [
      "/api/deployments",
      "/api/deployments/projects",
      "/api/deployments/discover",
      "/api/deployments/candidates/release-1/action",
    ])
      expect(isPath(path)).toBe(true);
    for (const path of ["https://example.com/api/deployments", "/api/../secret"])
      expect(isPath(path)).toBe(false);
  });
  it("only offers deploying after qualification and keeps superseded releases inert", () => {
    expect(deploymentActions("merged")).not.toContain("deploy");
    expect(deploymentActions("qualifying")).not.toContain("deploy");
    expect(deploymentActions("ready")).toContain("deploy");
    expect(deploymentActions("blocked")).toContain("retry");
    expect(deploymentActions("superseded")).toEqual([]);
    expect(deploymentActions("deploying", "deploy")).not.toContain("cancel");
    expect(deploymentActions("deploying", "preflight")).toContain("cancel");
    expect(deploymentActions("blocked", null, true)).toContain("verify");
    expect(deploymentActions("blocked", null, true)).not.toContain("cancel");
    expect(deploymentActions("verifying", "restart", false, true)).toEqual(["verify"]);
  });
});
