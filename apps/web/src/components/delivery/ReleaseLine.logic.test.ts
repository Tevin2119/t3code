import type {
  DeploymentCandidate,
  DeploymentProject,
  RepositoryIdentity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import recorded from "./ReleaseLine.fixtures.json";
import {
  instanceFacts,
  parseDeploymentCompare,
  promotesInto,
  pullRequestUrl,
  releaseLinesOf,
  repositoryIdentityFor,
  taskInstancesSummary,
} from "./ReleaseLine.logic";

const project = (id: string, extra: Partial<DeploymentProject> = {}): DeploymentProject => ({
  id,
  repository: "t3code",
  title: "T3 Code",
  branch: "main",
  environment: id,
  mode: "manual",
  adapter: "firebase-hosting",
  latestCommit: null,
  liveCommit: null,
  ...extra,
});
const candidate = (extra: Partial<DeploymentCandidate>): DeploymentCandidate => ({
  id: "c1",
  projectId: "app",
  commit: "a".repeat(40),
  baseCommit: null,
  state: "live",
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-20T10:00:00Z",
  evidence: null,
  events: [],
  ...extra,
});

describe("releaseLinesOf", () => {
  it("follows the engine's promotion order and keeps instances no line placed", () => {
    const projects = [project("t3code-app"), project("t3code-qa"), project("t3code-dev")];
    const lines = releaseLinesOf({
      projects,
      repositories: [],
      lines: recorded.lines,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.instances.map((entry) => entry.id)).toEqual([
      "t3code-qa",
      "t3code-app",
      "t3code-dev",
    ]);
  });

  it("keeps the listed order, one line per repository, for an engine without lines", () => {
    const lines = releaseLinesOf({
      projects: [project("b"), project("x", { repository: "other" }), project("a")],
      repositories: [],
    });
    expect(lines.map((line) => [line.repository, line.instances.map((p) => p.id)])).toEqual([
      ["t3code", ["b", "a"]],
      ["other", ["x"]],
    ]);
  });

  it("strips only between an instance and the one it promotes into", () => {
    const qa = project("qa", { promotesTo: "app" });
    expect(promotesInto(qa, project("app"))).toBe(true);
    expect(promotesInto(project("app"), project("sandbox"))).toBe(false);
    expect(promotesInto(qa, project("app", { repository: "other" }))).toBe(false);
  });
});

describe("instanceFacts", () => {
  const live = "b".repeat(40);
  it("names who deployed what runs, and the branch tip waiting ahead of it", () => {
    const app = project("app", {
      liveCommit: live,
      latestCommit: "c".repeat(40),
      liveCandidate: "c1",
      firebase: { firebaseProject: "demo-site", target: "app" },
    });
    const facts = instanceFacts(app, [
      candidate({
        commit: live,
        evidence: { servedFolder: "public" },
        events: [{ type: "deploying", by: "Sam" }],
      }),
      candidate({ id: "c2", commit: "c".repeat(40), state: "ready" }),
      candidate({ id: "other", projectId: "qa", evidence: { servedFolder: "sandbox" } }),
    ]);
    expect(facts).toMatchObject({
      tone: "waiting",
      target: "demo-site · app",
      servedFolder: "public",
      live: { commit: live, by: { name: "Sam", how: "deployed" } },
      waiting: { commit: "c".repeat(40), state: "ready" },
    });
  });

  it("names an adoption only for the commit it adopted, and a problem before anything else", () => {
    const adopted = project("app", { liveCommit: live, liveAdoptedBy: "Ana" });
    expect(instanceFacts(adopted, []).live.by).toEqual({ name: "Ana", how: "adopted" });
    const elsewhere = { ...adopted, liveAdoptedCommit: "d".repeat(40) };
    expect(instanceFacts(elsewhere, []).live.by).toBeNull();
    expect(instanceFacts({ ...adopted, liveProblem: "Unverified" }, []).tone).toBe("problem");
    expect(instanceFacts(project("app"), []).tone).toBe("unknown");
  });
});

describe("recorded compares", () => {
  it("decode as the engine recorded them", () => {
    const withHotfix = parseDeploymentCompare(recorded.withHotfix);
    expect(withHotfix?.promote).toBe("sync-hotfixes-first");
    expect(withHotfix?.ahead.prs.map((pr) => [pr.number, pr.kind, pr.source])).toEqual([
      [14, "fix", "squash-subject"],
      [12, "feature", "publication"],
    ]);
    expect(withHotfix?.folders?.onlyFrom).toBe(2);
    expect(parseDeploymentCompare(recorded.inSync)?.promote).toBe("promote");
    expect(parseDeploymentCompare({ ...recorded.inSync, ahead: null })).toBeNull();
  });
});

describe("pullRequestUrl", () => {
  const identity: RepositoryIdentity = {
    canonicalKey: "github.com/tevin2119/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:Tevin2119/t3code.git",
    },
    provider: "github",
    owner: "Tevin2119",
    name: "t3code",
    rootPath: "/work/t3code",
  } as RepositoryIdentity;

  it("uses the engine's URL, else the host's URL for the number, else none", () => {
    expect(pullRequestUrl({ url: "https://example.test/pull/1", number: 1 }, null)).toBe(
      "https://example.test/pull/1",
    );
    expect(pullRequestUrl({ url: null, number: 14 }, identity)).toMatch(/\/pull\/14$/);
    expect(pullRequestUrl({ url: null, number: 14 }, null)).toBeNull();
  });

  it("finds the T3 project with the engine repository's folder checked out", () => {
    const projects = [
      { workspaceRoot: "/elsewhere", repositoryIdentity: null },
      { workspaceRoot: "/work/t3code/", repositoryIdentity: identity },
    ];
    expect(repositoryIdentityFor("/work/t3code", projects)).toBe(identity);
    expect(repositoryIdentityFor("/work/other", projects)).toBeNull();
  });
});

describe("taskInstancesSummary", () => {
  it("says where a task is live, waiting and absent, in line order", () => {
    expect(
      taskInstancesSummary([
        { projectId: "qa", environment: "qa", state: "live" },
        { projectId: "app", environment: "app", state: "absent" },
      ]),
    ).toBe("Live on qa, not on app");
    expect(
      taskInstancesSummary([
        { projectId: "qa", environment: "qa", state: "waiting" },
        { projectId: "app", environment: "app", state: "absent" },
      ]),
    ).toBe("Merged, waiting on qa, not on app");
    expect(taskInstancesSummary([])).toBeNull();
  });
});
