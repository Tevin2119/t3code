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
import syncConflicts from "./ReleaseLine.syncConflicts.json";
import {
  compareReadingProblem,
  instanceFacts,
  parseDeploymentCompare,
  promoteBlocked,
  promoteConfirm,
  promotesInto,
  promotionActionConfirm,
  promotionConfirmation,
  promotionView,
  pullRequestUrl,
  releaseLinesOf,
  repositoryIdentityFor,
  repositoryProjectFor,
  stripPromotion,
  survivalRows,
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
      state: "awaiting-checks",
      problem: "Sync PR #7 waits for review.",
    });
    expect(view).toEqual({
      label: "awaiting-checks",
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
      fromBranch: "qa",
      to: "app",
      toBranch: "main",
    });
    expect(advance.path).toBe(`/api/deployments/promotions/${ready.id}/action`);
    expect(advance.body).toEqual({ action: "advance" });
    expect(advance.moves).toContain(`Moves main to ${ready.source!.slice(0, 12)}`);
  });
});

describe("promoting only what the engine will move", () => {
  const afterPromoted = parseDeploymentCompare(promotions.compareAfterPromoted)!;
  const inSync = parseDeploymentCompare(recorded.inSync)!;

  it("waits for the instance to deploy once its branch tip holds from's live commit", () => {
    // Recorded: main moved to qa's live commit; app still runs the old one, so ahead is not empty.
    expect(afterPromoted.promote).toBe("promote");
    expect(afterPromoted.ahead.count).toBeGreaterThan(0);
    expect(promoteBlocked(afterPromoted)).toBe(
      `main already holds qa's live commit ${afterPromoted.points.fromLive!.slice(0, 12)}. Waiting for app to deploy it.`,
    );
  });

  it("waits too when the tip is past from's live commit, read from compare's ranges", () => {
    const later = {
      ...afterPromoted,
      points: { ...afterPromoted.points, toTip: "f".repeat(40) },
      waiting: {
        ...afterPromoted.waiting,
        loose: [...afterPromoted.waiting.loose, { commit: "f".repeat(40), subject: "later" }],
        count: afterPromoted.waiting.count + 1,
      },
    };
    expect(promoteBlocked(later)).toMatch(/Waiting for app to deploy it\.$/);
    // A truncated range cannot show every commit is on the tip, so the engine decides.
    expect(promoteBlocked({ ...later, waiting: { ...later.waiting, truncated: true } })).toBeNull();
  });

  it("offers promote when from has work the tip lacks, and never blocks a sync", () => {
    expect(promoteBlocked(inSync)).toBeNull();
    expect(promoteBlocked(parseDeploymentCompare(recorded.withHotfix)!)).toBeNull();
    expect(promoteBlocked({ ...inSync, ahead: { ...inSync.ahead, count: 0 } })).toBe(
      "Nothing on qa is missing from release.",
    );
  });

  it("says why a stale or failed difference cannot back a promotion", () => {
    expect(compareReadingProblem({ error: "engine offline", stale: false, hasCompare: true })).toBe(
      "The difference could not be read: engine offline",
    );
    expect(compareReadingProblem({ error: null, stale: true, hasCompare: true })).toMatch(
      /out of date/,
    );
    expect(compareReadingProblem({ error: null, stale: false, hasCompare: false })).toMatch(
      /not been read yet/,
    );
    expect(compareReadingProblem({ error: null, stale: false, hasCompare: true })).toBeNull();
  });
});

describe("the confirmation shows what the engine will read", () => {
  const states = promotions.states as unknown as Record<string, DeploymentPromotion>;
  const withHotfix = parseDeploymentCompare(recorded.withHotfix)!;
  const afterPromoted = parseDeploymentCompare(promotions.compareAfterPromoted)!;
  const sides = {
    from: { environment: "qa", branch: "qa" },
    to: { environment: "app", branch: "main", mode: "manual" as const },
  };
  const opened = "2026-11-27T05:00:00.000Z";
  const later = "2026-11-27T05:00:02.000Z";

  it("waits for a read taken after it opened, then builds the text from it", () => {
    const promote = { kind: "promote" as const, openedAt: opened };
    expect(
      promotionConfirmation({
        ...sides,
        pending: promote,
        readAt: opened,
        error: null,
        compare: withHotfix,
        promotion: null,
      }),
    ).toEqual({ state: "reading" });
    const ready = promotionConfirmation({
      ...sides,
      pending: promote,
      readAt: later,
      error: null,
      compare: withHotfix,
      promotion: null,
    });
    expect(ready.state === "ready" && ready.confirm.moves).toContain(
      withHotfix.points.toTip!.slice(0, 12),
    );
  });

  it("refuses when the fresh read shows the promotion already happened, or failed", () => {
    const promote = { kind: "promote" as const, openedAt: opened };
    expect(
      promotionConfirmation({
        ...sides,
        pending: promote,
        readAt: later,
        error: null,
        compare: afterPromoted,
        promotion: null,
      }),
    ).toEqual({ state: "problem", why: promoteBlocked(afterPromoted) });
    expect(
      promotionConfirmation({
        ...sides,
        pending: promote,
        readAt: later,
        error: "502",
        compare: withHotfix,
        promotion: null,
      }),
    ).toEqual({ state: "problem", why: "The difference could not be read: 502" });
  });

  it("advance waits for the fresh read; retry and cancel do not rest on it", () => {
    const at = (action: "advance" | "retry" | "cancel") => ({
      kind: "action" as const,
      action,
      openedAt: opened,
    });
    const base = {
      ...sides,
      readAt: opened,
      error: "502",
      compare: withHotfix,
      promotion: states["ready"]!,
    };
    expect(promotionConfirmation({ ...base, pending: at("advance") }).state).toBe("problem");
    expect(promotionConfirmation({ ...base, pending: at("cancel") }).state).toBe("ready");
    expect(promotionConfirmation({ ...base, pending: at("retry") }).state).toBe("ready");
    expect(promotionConfirmation({ ...base, pending: at("cancel"), promotion: null })).toEqual({
      state: "problem",
      why: "This promotion is no longer listed.",
    });
  });
});

describe("a sync conflict through the sync PR (D3b)", () => {
  // Recorded from the engine's promotions.mjs at 0cef3352, through the same snapshot decoder.
  const recordedSync = parseDeployments({
    version: 1,
    problem: null,
    projects: [],
    candidates: [],
    repositories: [],
    capabilities: { engine: false, command: true, "firebase-hosting": false },
    promotions: Object.values(syncConflicts.states),
  })!.promotions!;
  const sync = Object.fromEntries(
    recordedSync.map((p, i) => [Object.keys(syncConflicts.states)[i]!, p]),
  );
  const names = { from: "qa", fromBranch: "qa", to: "app", toBranch: "main" };
  const qa = { environment: "qa", branch: "qa" };
  const app = { environment: "app", branch: "main", mode: "manual" as const };

  it("decodes the recorded promotions with their sync PR, hotfixes and report", () => {
    expect(recordedSync).toHaveLength(Object.keys(syncConflicts.states).length);
    const conflicted = sync["conflicted"]!;
    expect(conflicted.syncPr?.url).toBe("https://github.com/Tevin2119/t3code-fixture/pull/7");
    expect(conflicted.syncPr?.head).toBe(`paperclip/sync/${conflicted.id}`);
    expect(conflicted.hotfixes?.count).toBe(3);
    expect(conflicted.conflict?.files).toEqual(["app/banner.txt", "app/price.txt"]);
    expect(sync["resolved"]!.resolution?.report?.counts).toEqual({
      present: 1,
      changed: 1,
      missing: 1,
      superseded: 1,
    });
  });

  it("offers approve only when resolved, and a way out in every sync state", () => {
    expect(
      Object.fromEntries(Object.entries(sync).map(([name, p]) => [name, promotionView(p).actions])),
    ).toEqual({
      opening: [],
      conflicted: ["retry", "cancel"],
      resolved: ["approve", "retry", "cancel"],
      resolvedNewer: ["approve", "retry", "cancel"],
      "awaiting-merge": ["retry", "cancel"],
    });
  });

  it("lists missing and changed hunks first, and a superseded one as superseded", () => {
    const rows = survivalRows(sync["resolved"]!.resolution!.report!);
    expect(rows.map((row) => [row.path, row.status, row.tone])).toEqual([
      ["app/price.txt", "missing", "missing"],
      ["app/banner.txt", "changed", "changed"],
      ["app/hotfix.js", "superseded", "other"],
      ["app/hotfix.js", "present", "kept"],
    ]);
  });

  it("approves the head whose report was shown, keyed and named by the approval dialog", () => {
    const resolved = sync["resolved"]!;
    const head = resolved.resolution!.head;
    const approve = promotionActionConfirm(resolved, "approve", names);
    expect(approve.path).toBe(`/api/deployments/promotions/${resolved.id}/action`);
    expect(approve.body).toEqual({ action: "approve", head });
    expect(approve.moves).toContain(`Fast-forwards qa to the sync head ${head.slice(0, 12)}`);
    expect(approve.moves).toContain("1 present, 1 changed, 1 missing");
    expect(approve.moves).toContain("2 hunks are approved as they stand.");
    const shown = promotionConfirmation({
      pending: { kind: "action", action: "approve", openedAt: null, head },
      readAt: null,
      error: null,
      compare: null,
      promotion: resolved,
      to: app,
      from: qa,
    });
    expect(shown).toEqual({ state: "ready", confirm: approve });
  });

  it("says the head moved when a refresh reports on a newer push, and asks again", () => {
    const shownHead = sync["resolved"]!.resolution!.head;
    const newer = sync["resolvedNewer"]!;
    const moved = promotionConfirmation({
      pending: { kind: "action", action: "approve", openedAt: null, head: shownHead },
      readAt: null,
      error: null,
      compare: null,
      promotion: newer,
      to: app,
      from: qa,
    });
    expect(moved).toEqual({
      state: "moved",
      head: newer.resolution!.head,
      why: `The sync branch moved: the report shown was for ${shownHead.slice(0, 12)}, and the engine now reports on ${newer.resolution!.head.slice(0, 12)}. Review ${newer.resolution!.head.slice(0, 12)} to see its report here before approving it.`,
    });
    // The engine refuses the old head the same way (recorded): 400, read the report again.
    expect(syncConflicts.approveStaleHead.status).toBe(400);
    expect(syncConflicts.approveNoHead.status).toBe(400);
  });

  it("refuses an approve once the promotion left resolved, or its report failed", () => {
    const pending = {
      kind: "action",
      action: "approve",
      openedAt: null,
      head: "a".repeat(40),
    } as const;
    const base = { pending, readAt: null, error: null, compare: null, to: app, from: qa };
    expect(promotionConfirmation({ ...base, promotion: sync["awaiting-merge"]! }).state).toBe(
      "problem",
    );
    const failed = {
      ...sync["resolved"]!,
      resolution: {
        ...sync["resolved"]!.resolution!,
        report: { ...sync["resolved"]!.resolution!.report!, problem: "A file could not be read." },
      },
    };
    expect(promotionConfirmation({ ...base, promotion: failed })).toEqual({
      state: "problem",
      why: "The survival report could not be made, so there is nothing to approve: A file could not be read.",
    });
  });

  it("finds the T3 project that has the engine repository checked out", () => {
    const identity = {
      canonicalKey: "k",
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: "u" },
    } as never;
    const projects = [
      {
        id: "other",
        environmentId: "laptop",
        workspaceRoot: "/repo",
        repositoryIdentity: identity,
      },
      { id: "p1", environmentId: "host", workspaceRoot: "/repo/", repositoryIdentity: identity },
    ];
    expect(repositoryProjectFor("/repo", projects, "host")?.id).toBe("p1");
    expect(repositoryProjectFor("/repo", projects, "desk")).toBeNull();
    expect(repositoryProjectFor("/elsewhere", projects, "host")).toBeNull();
  });
});
