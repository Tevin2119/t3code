import type {
  DeploymentCandidate,
  DeploymentProject,
  DeploymentPromotion,
  RepositoryIdentity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { parseDeployments } from "../../lib/deployments";
import recorded from "./ReleaseLine.fixtures.json";
import promotions from "./ReleaseLine.promotions.json";
import {
  instanceFacts,
  parseDeploymentCompare,
  promoteConfirm,
  promotesInto,
  promotionActionConfirm,
  promotionView,
  pullRequestUrl,
  releaseLinesOf,
  repositoryIdentityFor,
  stripPromotion,
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

  it("reads the newest candidate first, as the engine lists them, when none is live", () => {
    const tip = "c".repeat(40);
    const app = project("app", { liveCommit: live, latestCommit: tip });
    const facts = instanceFacts(app, [
      candidate({
        id: "new",
        seq: 3,
        commit: tip,
        state: "ready",
        evidence: { servedFolder: "dist" },
      }),
      candidate({
        id: "old",
        seq: 1,
        commit: tip,
        state: "superseded",
        evidence: { servedFolder: "public" },
      }),
    ]);
    expect(facts.servedFolder).toBe("dist");
    expect(facts.waiting).toEqual({ commit: tip, state: "ready" });
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

describe("promotions on the strip", () => {
  const states = promotions.states as unknown as Record<string, DeploymentPromotion>;
  const compare = parseDeploymentCompare(recorded.withHotfix)!;
  const inSync = parseDeploymentCompare(recorded.inSync)!;

  it("decodes every recorded state, and shows each engine reason as it wrote it", () => {
    const snapshot = parseDeployments({
      version: 1,
      projects: [],
      candidates: [],
      repositories: [],
      capabilities: { engine: false, command: true, "firebase-hosting": false },
      promotions: Object.values(states),
    });
    expect(snapshot?.promotions).toHaveLength(Object.keys(states).length);
    expect(promotionView(states["conflicted"]!).reason).toBe(states["conflicted"]!.problem);
    expect(promotionView(states["blocked"]!).reason).toBe(states["blocked"]!.problem);
    expect(promotionView(states["awaiting-qa"]!).reason).toBe(states["awaiting-qa"]!.waiting);
    expect(promotionView(states["ready"]!).reason).toBeNull();
  });

  it("offers the actions the engine takes in each state", () => {
    const offered = Object.fromEntries(
      Object.entries(states).map(([name, promotion]) => [name, promotionView(promotion).actions]),
    );
    expect(offered).toEqual({
      planned: ["cancel"],
      syncing: [],
      "awaiting-qa": ["cancel"],
      ready: ["advance", "cancel"],
      advancing: [],
      promoted: [],
      conflicted: ["retry", "cancel"],
      cancelled: [],
      blocked: ["retry", "cancel"],
    });
  });

  it("shows a state it does not know by name, with its reason and a way out", () => {
    const view = promotionView({
      ...states["conflicted"]!,
      state: "awaiting-merge",
      problem: "Sync PR #7 waits for review.",
    });
    expect(view).toEqual({
      label: "awaiting-merge",
      tone: "unknown",
      reason: "Sync PR #7 waits for review.",
      actions: ["cancel"],
      open: true,
    });
  });

  it("shows the open promotion into an instance, else the pair's latest", () => {
    const old = { ...states["promoted"]!, id: "old", createdAt: "2026-01-01T00:00:00Z" };
    const open = { ...states["blocked"]!, id: "open", createdAt: "2025-01-01T00:00:00Z" };
    const cancelled = { ...states["cancelled"]!, id: "new", createdAt: "2026-02-01T00:00:00Z" };
    expect(stripPromotion([old, open, cancelled], "t3code-qa", "t3code-app")?.id).toBe("open");
    expect(stripPromotion([old, cancelled], "t3code-qa", "t3code-app")?.id).toBe("new");
    expect(stripPromotion([old], "t3code-app", "t3code-qa")).toBeNull();
    expect(stripPromotion(undefined, "t3code-qa", "t3code-app")).toBeNull();
  });

  it("says what moves: from which commit to which branch", () => {
    const sync = promoteConfirm(compare, { mode: "manual" });
    expect(sync.path).toBe("/api/deployments/promotions");
    expect(sync.body).toEqual({ from: "t3code-qa", to: "t3code-app" });
    expect(sync.moves).toContain(`Merges main (${compare.points.toTip!.slice(0, 12)}`);
    expect(sync.moves).toContain(`into qa (${compare.points.fromTip!.slice(0, 12)})`);
    expect(sync.moves).toContain("waits, ready, for a named person to advance main");
    expect(promoteConfirm(compare, { mode: "full-auto" }).moves).toContain(
      "app is full auto, so main then moves on its own",
    );
    const plain = promoteConfirm(inSync, { mode: "manual" });
    expect(plain.title).toBe("Promote qa into release");
    expect(plain.moves).toBe(
      `Moves release to qa's verified live commit ${inSync.points.fromLive!.slice(0, 12)}, with a plain push that is never forced.`,
    );
    const ready = states["ready"]!;
    const advance = promotionActionConfirm(ready, "advance", {
      from: "qa",
      to: "app",
      toBranch: "main",
    });
    expect(advance.path).toBe(`/api/deployments/promotions/${ready.id}/action`);
    expect(advance.body).toEqual({ action: "advance" });
    expect(advance.moves).toContain(`Moves main to ${ready.source!.slice(0, 12)}`);
  });
});
