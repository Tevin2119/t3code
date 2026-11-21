import { describe, expect, it } from "vite-plus/test";

import { parseCard, parseTarget, type DeliveryCard } from "./delivery";
import {
  boardDeploymentLinkView,
  boardTargetDiagnostic,
  cardMergeExecutionFact,
  cardMergePermissionFact,
  cardPublicationFact,
  deliveryReadDiagnostic,
} from "./deliveryStates";

const project = {
  id: "deploy-app-staging",
  repository: "app",
  path: "/real/app",
  environment: "staging",
  branch: "main",
  mode: "auto-qualify",
  title: "App",
};
const link = (fields: Record<string, unknown>) => ({
  deploymentProjectId: null,
  state: "unlinked",
  problem: null,
  by: null,
  at: null,
  project: null,
  ...fields,
});
const policy = (fields: Record<string, unknown> = {}) => ({
  setting: "inherit",
  requestedBy: null,
  requestedSince: null,
  resolved: "off",
  eligible: false,
  source: "fallback",
  sourceId: null,
  by: null,
  since: null,
  board: "work",
  mode: "manual",
  problem: null,
  blockingReason: "permission-off",
  execution: "guarded",
  ...fields,
});
const pr = { number: 42, url: "https://github.com/owner/app/pull/42" };
const publication = (fields: Record<string, unknown> = {}) => ({
  state: "pr-open",
  branch: "delivery/7-thing-run-1",
  commit: "a".repeat(40),
  pullRequest: pr,
  error: null,
  attempts: 1,
  mergeCommit: null,
  mergeExecution: null,
  ...fields,
});
const live = (fields: Record<string, unknown> = {}) => ({
  publication: "pub-1",
  run: "run-1",
  task: "task-7",
  board: "work",
  projectId: project.id,
  repositoryPath: "/real/app",
  targetBranch: "main",
  project,
  headCommit: "a".repeat(40),
  pullRequest: pr,
  publicationState: "merged",
  mergeCommit: "c".repeat(40),
  state: "live",
  problem: null,
  candidate: {
    id: "cand-1",
    commit: "c".repeat(40),
    branch: "main",
    state: "live",
    inclusion: "ancestor",
    evidence: { passed: true },
    problem: null,
    failedPhase: null,
    liveAt: "2030-01-01T00:00:00.000Z",
    liveUntil: null,
  },
  history: [],
  updated: "2030-01-01T00:00:00.000Z",
  ...fields,
});
const card = (fields: Record<string, unknown>): DeliveryCard =>
  parseCard({ id: "task-7", run: { id: "run-1" }, ...fields } as never);

describe("board deployment link states", () => {
  it("not linked: offers the link only to a named person on a connection that may act", () => {
    const unlinked = link({});
    expect(boardDeploymentLinkView(unlinked as never, { person: "Sam", allowed: true })).toEqual({
      kind: "unlinked",
      canLink: true,
      needsName: false,
    });
    expect(boardDeploymentLinkView(unlinked as never, { person: "  ", allowed: true })).toEqual({
      kind: "unlinked",
      canLink: false,
      needsName: true,
    });
    expect(boardDeploymentLinkView(unlinked as never, { person: "Sam", allowed: false })).toEqual({
      kind: "unlinked",
      canLink: false,
      needsName: false,
    });
  });

  it("linked: the project, who linked it and when", () => {
    const value = link({
      deploymentProjectId: project.id,
      state: "linked",
      by: "Sam",
      at: "2030-01-01T00:00:00.000Z",
      project,
    });
    expect(boardDeploymentLinkView(value as never, { person: "", allowed: false })).toEqual({
      kind: "linked",
      project: "App",
      environment: "staging",
      by: "Sam",
      at: "2030-01-01T00:00:00.000Z",
    });
  });

  it("link has a problem: the engine's text, unchanged, also when the state still says linked", () => {
    const problem = "The board was retargeted; the link witness no longer matches.";
    for (const state of ["invalid", "linked"])
      expect(
        boardDeploymentLinkView(
          link({ deploymentProjectId: project.id, state, problem, project }) as never,
          { person: "Sam", allowed: true },
        ),
      ).toEqual({ kind: "invalid", problem });
  });

  it("an engine that reports no link is unavailable, not unlinked", () => {
    expect(boardDeploymentLinkView(null, { person: "Sam", allowed: true })).toEqual({
      kind: "unavailable",
    });
  });
});

describe("board target diagnostics", () => {
  it.each([
    [null, "missing-target", null],
    [
      { repository: null, base: null, ok: false, problem: "Repository not configured" },
      "missing-target",
      "Repository not configured",
    ],
    [
      {
        repository: "app",
        base: null,
        path: "/real/app",
        ok: false,
        problem: "no base branch is set",
      },
      "missing-target",
      "no base branch is set",
    ],
    [
      { repository: "gone", base: "main", path: null, ok: false, problem: "not on the list" },
      "unregistered-repository",
      "not on the list",
    ],
  ])("%j is %s", (target, code, problem) => {
    expect(boardTargetDiagnostic(parseTarget(target))).toEqual({ code, problem });
  });

  it("a usable target has no diagnostic", () => {
    const target = { repository: "app", base: "main", path: "/real/app", ok: true, problem: null };
    expect(boardTargetDiagnostic(parseTarget(target))).toBeNull();
  });
});

describe("card publication states", () => {
  it("no publication: nothing", () => {
    expect(cardPublicationFact(card({}))).toBeNull();
  });

  it("pull request open: its link", () => {
    expect(cardPublicationFact(card({ publication: publication() }))).toEqual({
      kind: "pull-request",
      ...pr,
    });
  });

  it("merged: the merge commit the host reported, or that none was reported", () => {
    expect(
      cardPublicationFact(
        card({ publication: publication({ state: "merged", mergeCommit: "f00d" }) }),
      ),
    ).toEqual({ kind: "merged", mergeCommit: "f00d", pullRequest: pr });
    expect(
      cardPublicationFact(card({ publication: publication({ state: "merged" }) })),
    ).toMatchObject({ kind: "merged", mergeCommit: null });
  });

  it("deployed: the project, with preview, logs and id only once the engine sends them", () => {
    const deployed = cardPublicationFact(
      card({
        publication: publication({ state: "merged" }),
        deployment: { current: live(), history: [] },
      }),
    );
    expect(deployed).toEqual({
      kind: "deployed",
      project: "App",
      environment: "staging",
      pullRequest: pr,
      previewUrl: null,
      deploymentId: null,
      logsUrl: null,
    });
    const reported = cardPublicationFact(
      card({
        deployment: {
          current: live({ previewUrl: "https://p", logsUrl: "https://l", deploymentId: "d-1" }),
          history: [],
        },
      }),
    );
    expect(reported).toMatchObject({
      previewUrl: "https://p",
      logsUrl: "https://l",
      deploymentId: "d-1",
    });
  });

  it("an earlier run's live deployment, or one not yet verified live, is not this card's deployment", () => {
    const merged = publication({ state: "merged", mergeCommit: "f00d" });
    expect(
      cardPublicationFact(
        card({ publication: merged, deployment: { current: live({ run: "run-0" }), history: [] } }),
      ),
    ).toMatchObject({ kind: "merged" });
    expect(
      cardPublicationFact(
        card({
          publication: merged,
          deployment: { current: live({ state: "ready" }), history: [] },
        }),
      ),
    ).toMatchObject({ kind: "merged" });
  });

  it("other publication states are shown as the engine names them", () => {
    expect(cardPublicationFact(card({ publication: publication({ state: "failed" }) }))).toEqual({
      kind: "publication",
      state: "failed",
    });
  });
});

describe("card merge permission states", () => {
  it("off: which layer set it, and fallback when nothing was set", () => {
    expect(cardMergePermissionFact(policy() as never)).toEqual({
      kind: "off",
      source: "fallback",
      sourceId: null,
    });
    expect(cardMergePermissionFact(policy({ source: "board", sourceId: "work" }) as never)).toEqual(
      {
        kind: "off",
        source: "board",
        sourceId: "work",
      },
    );
  });

  it("on and not eligible: the blocking reason, as the engine gave it", () => {
    const value = policy({ resolved: "on", source: "task", blockingReason: "full-auto-required" });
    expect(cardMergePermissionFact(value as never)).toEqual({
      kind: "not-eligible",
      blockingReason: "full-auto-required",
    });
  });

  it("eligible is never computed here: only the engine's flag says so", () => {
    const value = policy({ resolved: "on", eligible: true, blockingReason: null, mode: "manual" });
    expect(cardMergePermissionFact(value as never)).toEqual({ kind: "eligible" });
  });

  it("a damaged policy shows its problem", () => {
    const value = policy({ source: "problem", problem: "merge-permission.json is damaged" });
    expect(cardMergePermissionFact(value as never)).toEqual({
      kind: "problem",
      problem: "merge-permission.json is damaged",
    });
  });
});

describe("card merge execution states", () => {
  const execution = (state: string, reason: string | null, permission = policy()) =>
    cardMergeExecutionFact(
      card({
        publication: publication({ mergeExecution: { state, reason, mergeCommit: null } }),
        mergePermission: permission,
      }),
    );

  it.each([
    ["queued", "awaiting-process-admission", "in-progress"],
    ["intent", null, "in-progress"],
    ["blocked", "approval-does-not-stand", "failed"],
    ["uncertain", "github-refs-landed-pr-not-merged", "uncertain"],
    ["not-evaluated", "awaiting-publication-discovery", "waiting"],
    ["something-new", null, "unknown"],
  ])("%s with %s is %s", (state, reason, group) => {
    expect(execution(state, reason)).toEqual({ group, state, reason });
  });

  it("merged and observed are the Merged fact, not a merge line", () => {
    expect(execution("merged", null)).toBeNull();
    expect(execution("observed", null)).toBeNull();
  });

  it("a merge blocked for the permission's own reason is said once, by the permission", () => {
    expect(execution("blocked", "permission-off")).toBeNull();
  });
});

describe("read diagnostics", () => {
  const refusal = (status: number) => ({ _tag: "DeliveryError", reason: "refused", status });
  it("a task read answered 404 is a task not found; elsewhere it is not", () => {
    expect(deliveryReadDiagnostic(refusal(404), { task: true })).toBe("task-not-found");
    expect(deliveryReadDiagnostic(refusal(404))).toBe("unsupported-server");
    expect(deliveryReadDiagnostic(refusal(403))).toBe("unauthorized");
    expect(deliveryReadDiagnostic(null)).toBe("unsupported-server");
  });
});
