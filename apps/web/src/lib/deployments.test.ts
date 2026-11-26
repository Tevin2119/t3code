import { describe, expect, it } from "vite-plus/test";
import {
  DeploymentActionInput,
  DeploymentProjectInput,
  DeliveryPath,
  type DeploymentCandidate,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  deploymentRequestBody,
  deploymentActions,
  deploymentStatus,
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
  const candidate = (changes: Partial<DeploymentCandidate>): DeploymentCandidate => ({
    id: "release-1",
    projectId: "project-1",
    commit: "a".repeat(40),
    baseCommit: null,
    state: "merged",
    createdAt: "2026-10-28T00:00:00Z",
    updatedAt: "2026-10-28T00:00:00Z",
    evidence: null,
    events: [],
    ...changes,
  });
  it("only offers deploying after qualification and keeps superseded releases inert", () => {
    expect(deploymentActions(candidate({ state: "merged" }))).not.toContain("deploy");
    expect(deploymentActions(candidate({ state: "qualifying" }))).not.toContain("deploy");
    expect(deploymentActions(candidate({ state: "ready" }))).toContain("deploy");
    expect(deploymentActions(candidate({ state: "superseded" }))).toEqual([]);
    expect(deploymentActions(candidate({ state: "deploying", phase: "deploy" }))).not.toContain(
      "cancel",
    );
    expect(deploymentActions(candidate({ state: "deploying", phase: "preflight" }))).toContain(
      "cancel",
    );
    const unverified = candidate({ state: "blocked", needsVerify: true, failedPhase: "deploy" });
    expect(deploymentActions(unverified)).toContain("verify");
    expect(deploymentActions(unverified)).not.toContain("cancel");
    expect(
      deploymentActions(candidate({ state: "verifying", phase: "restart", awaitingRestart: true })),
    ).toEqual(["verify"]);
  });
  it("hides a repeated cancel and retries the engine would refuse", () => {
    expect(deploymentActions(candidate({ state: "qualifying", cancelRequested: "Sam" }))).toEqual(
      [],
    );
    const failedQualify = { state: "blocked" as const, failedPhase: "qualify" };
    expect(
      deploymentActions(candidate({ ...failedQualify, attempts: { qualify: 4, deploy: 0 } })),
    ).toContain("retry");
    expect(
      deploymentActions(candidate({ ...failedQualify, attempts: { qualify: 5, deploy: 0 } })),
    ).not.toContain("retry");
    const failedDeploy = { state: "blocked" as const, failedPhase: "deploy" };
    expect(deploymentActions(candidate({ ...failedDeploy, evidence: { passed: true } }))).toContain(
      "retry",
    );
    expect(
      deploymentActions(candidate({ ...failedDeploy, evidence: { passed: false } })),
    ).not.toContain("retry");
    expect(
      deploymentActions(
        candidate({
          ...failedDeploy,
          evidence: { passed: true },
          attempts: { qualify: 1, deploy: 5 },
        }),
      ),
    ).not.toContain("retry");
    // A cancelled ready release resumes without a new attempt.
    expect(
      deploymentActions(
        candidate({ ...failedDeploy, resumeState: "ready", attempts: { qualify: 1, deploy: 5 } }),
      ),
    ).toContain("retry");
  });
  it("offers only stopping while another release for the environment runs", () => {
    expect(deploymentActions(candidate({ state: "merged" }), true)).toEqual(["cancel"]);
    expect(deploymentActions(candidate({ state: "ready" }), true)).toEqual(["cancel"]);
    expect(deploymentActions(candidate({ state: "live" }), true)).toEqual([]);
    expect(
      deploymentActions(
        candidate({ state: "verifying", phase: "restart", awaitingRestart: true }),
        true,
      ),
    ).toEqual(["verify"]);
  });
  it("offers adopt only for a qualified Firebase Hosting candidate, never while busy", () => {
    const qualified = candidate({ state: "ready", evidence: { passed: true, site: "app" } });
    expect(deploymentActions(qualified, false, "firebase-hosting")).toContain("adopt");
    expect(deploymentActions(qualified, true, "firebase-hosting")).not.toContain("adopt");
    expect(deploymentActions(qualified, false, "command")).not.toContain("adopt");
    expect(
      deploymentActions(candidate({ state: "merged" }), false, "firebase-hosting"),
    ).not.toContain("adopt");
  });
  it("shows Firebase live state as the engine reports it and derives none", () => {
    const latest = "a".repeat(40);
    const base = {
      adapter: "firebase-hosting" as const,
      latestCommit: latest,
      liveCommit: latest,
      liveObservedAt: "2026-11-26T00:00:00Z",
    };
    const unverified =
      "Unverified since the branch head moved to bbbbbbbbbb; the site has not been read since.";
    expect(deploymentStatus({ ...base, liveProblem: unverified })).toBe(unverified);
    expect(deploymentStatus({ ...base, liveCandidate: "c7" })).toBe("Live: release c7");
    // Named as its candidate card is, so the two can be matched.
    expect(
      deploymentStatus({ ...base, liveCandidate: "c7" }, false, { seq: 4, commit: "f".repeat(40) }),
    ).toBe("Live: Release #4 · ffffffffff");
    // A matching commit is not a claim: only the engine's liveCandidate is.
    expect(deploymentStatus(base)).toBe("The engine reports no live release.");
  });
  it("reports whether the running revision matches without calling it healthy", () => {
    const latest = "a".repeat(40);
    const hotfix = "b".repeat(40);
    const liveObservedAt = "2026-10-28T00:00:00Z";
    expect(deploymentStatus({ latestCommit: latest, liveCommit: latest, liveObservedAt })).toBe(
      "Running revision matches latest merge",
    );
    expect(deploymentStatus({ latestCommit: latest, liveCommit: hotfix, liveObservedAt })).toBe(
      "Running revision differs from latest merge",
    );
    expect(
      deploymentStatus({ latestCommit: latest, liveCommit: latest, liveProblem: "Health failed" }),
    ).toBe("Running revision problem: Health failed");
    expect(deploymentStatus({ latestCommit: null, liveCommit: hotfix, liveObservedAt })).toBe(
      "No merged revision discovered",
    );
    expect(deploymentStatus({ latestCommit: latest, liveCommit: null })).toBe(
      "Running revision is unknown",
    );
    expect(deploymentStatus({ latestCommit: latest, liveCommit: null, liveObservedAt })).toBe(
      "No revision deployed at last observation",
    );
    for (const observed of [undefined, "", "invalid date"]) {
      expect(
        deploymentStatus({ latestCommit: latest, liveCommit: latest, liveObservedAt: observed }),
      ).toBe("Runtime observation time is unknown");
    }
    expect(
      deploymentStatus({
        latestCommit: latest,
        liveCommit: latest,
        liveObservedAt,
        problem: "Discovery failed",
      }),
    ).toBe("Deployment problem: Discovery failed");
    expect(
      deploymentStatus({ latestCommit: latest, liveCommit: latest, liveObservedAt }, true),
    ).toBe("Runtime status unavailable. Showing last reading.");
  });
});
