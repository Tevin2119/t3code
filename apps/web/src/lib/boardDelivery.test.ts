import { describe, expect, it } from "vite-plus/test";
import {
  boardDeliveryRequest,
  parseTaskDeployment,
  taskDeploymentLabel,
  taskDeploymentStatus,
} from "./boardDelivery";
import { parseBoard, parseCard } from "./delivery";

const project = {
  id: "deploy-app-staging",
  repository: "alias",
  path: "/real/app",
  environment: "staging",
  branch: "main",
  mode: "manual",
  title: "App",
};
const candidate = {
  id: "cand-1",
  commit: "b".repeat(40),
  branch: "main",
  state: "live",
  inclusion: "ancestor",
  evidence: { passed: true },
  problem: null,
  failedPhase: null,
  liveAt: "2030-01-01T00:00:00.000Z",
  liveUntil: null,
};
const publication = {
  publication: "digest",
  run: "old-run",
  task: "task-1",
  board: "original",
  projectId: project.id,
  repositoryPath: project.path,
  targetBranch: "main",
  project,
  headCommit: "a".repeat(40),
  pullRequest: { number: 42, url: "https://github.com/owner/app/pull/42" },
  publicationState: "merged",
  mergeCommit: "c".repeat(40),
  state: "live",
  problem: null,
  candidate,
  history: [],
  updated: "2030-01-01T00:00:00.000Z",
};
const mergePermission = {
  setting: "inherit",
  requestedBy: null,
  requestedSince: null,
  resolved: "on",
  eligible: false,
  source: "ancestor",
  sourceId: "task-parent",
  by: "Sam",
  since: "2030-01-01T00:00:00.000Z",
  board: "work",
  mode: "streamlined",
  blockingReason: "full-auto-required",
  problem: null,
  execution: "guarded",
};

describe("board delivery contract", () => {
  it("links explicit IDs without mode changes and rejects ambiguous selectors", () => {
    const path = "/api/boards/work/deployment";
    const auth = { by: "Sam", key: "test-only-key" };
    expect(boardDeliveryRequest(path, { ...auth, deploymentProjectId: project.id })).toEqual({
      ...auth,
      deploymentProjectId: project.id,
    });
    expect(boardDeliveryRequest(path, { ...auth, deploymentProjectId: null })).toEqual({
      ...auth,
      deploymentProjectId: null,
    });
    for (const body of [
      { ...auth, branch: "main" },
      { ...auth, deploymentProjectId: project.id, environment: "production" },
      { ...auth, deploymentProjectId: [project.id] },
      { ...auth, deploymentProjectId: project.id, mode: "auto-qualify" },
    ])
      expect(() => boardDeliveryRequest(path, body)).toThrow();
    const create = {
      repository: "app",
      branch: "main",
      environment: "staging",
      adapter: "command",
      commands: { qualify: ["check"], deploy: ["ship"], verify: ["health"] },
    };
    expect(boardDeliveryRequest(path, { ...auth, create })).toEqual({ ...auth, create });
    const automatic = { ...auth, create: { ...create, mode: "full-auto" } };
    expect(() => boardDeliveryRequest(path, automatic)).toThrow();
    expect(boardDeliveryRequest(path, { ...automatic, confirmed: true })).toEqual({
      ...automatic,
      confirmed: true,
    });
    expect(() =>
      boardDeliveryRequest(path, { ...auth, create, deploymentProjectId: project.id }),
    ).toThrow();
  });

  it("requires direct consent for merge-on at every scope, not for off or inherit", () => {
    for (const scope of ["engine", "boards/work", "tasks/task-1"]) {
      const path = `/api/${scope}/merge-permission`;
      for (const setting of ["on", "off", "inherit"]) {
        const body = { mergePermission: setting, by: "Sam", key: "test-only-key" };
        expect(() => boardDeliveryRequest(path, { ...body, key: "" })).toThrow();
        if (setting === "on") expect(() => boardDeliveryRequest(path, body)).toThrow();
        else expect(boardDeliveryRequest(path, body)).toEqual(body);
        expect(boardDeliveryRequest(path, { ...body, confirmed: true })).toEqual({
          ...body,
          confirmed: true,
        });
      }
    }
  });

  it("keeps frozen attribution and ancestor policy in the existing card and lane snapshot", () => {
    const deployment = {
      current: publication,
      history: [{ ...publication, publication: "older", run: "older-run" }],
    };
    const card = parseCard({ id: "task-1", run: { id: "new-run" }, deployment, mergePermission });
    expect(card.deployment).toEqual(deployment);
    expect(card.mergePermission).toEqual(mergePermission);
    expect(taskDeploymentLabel(card.deployment!, card.run?.id ?? null)).toBe(
      "Earlier run: live · staging",
    );
    const link = {
      deploymentProjectId: project.id,
      state: "invalid",
      problem: "Watch changed",
      by: "Sam",
      at: "2030-01-01T00:00:00.000Z",
      project,
    };
    const board = parseBoard({
      sets: [{ id: "work", deployment: link, mergePermission }],
      lanes: [{ lane: "done", cards: [{ deployment }] }],
    });
    expect(board?.sets[0]?.deployment).toEqual(link);
    expect(board?.sets[0]?.mergePermission).toEqual(mergePermission);
    expect(board?.lanes[0]?.cards[0]?.deployment?.current.project?.environment).toBe("staging");
  });

  it("never promotes unknown, dirty, blocked or unverified outcomes to success", () => {
    const parsed = parseTaskDeployment({ current: publication, history: [] })!;
    expect(taskDeploymentStatus(parsed.current).state).toBe("live");
    for (const [state, problem, candidateValue, expected] of [
      ["queued", "Unknown merge commit", null, "queued"],
      ["queued", "Awaiting reconciliation", null, "queued"],
      ["ready", "Runtime unhealthy", candidate, "blocked"],
      ["ready", null, null, "unknown"],
      ["live", null, { ...candidate, problem: "Runtime unhealthy" }, "blocked"],
      ["live", null, { ...candidate, liveAt: null }, "unknown"],
      ["live", null, { ...candidate, liveUntil: "2030-01-02" }, "unknown"],
      ["future-state", null, candidate, "unknown"],
      ["superseded", "Candidate pruned", candidate, "superseded"],
    ] as const) {
      expect(
        taskDeploymentStatus({ ...parsed.current, state, problem, candidate: candidateValue })
          .state,
      ).toBe(expected);
    }
    expect(parseTaskDeployment({ current: { state: "live" } })).toBeNull();
    expect(parseCard({}).deployment).toBeNull();
  });
});

import { deliveryProgress, deliveryTaskRequest, parseBoardDelivery } from "./boardDelivery";

it("keeps a retry tied to the same task and originating environment", () => {
  const task = { id: "task-a", origin: "thread:host-a/chat-a" };
  expect(deliveryTaskRequest("route", task, "host-a")).toEqual(
    deliveryTaskRequest("route", task, "host-a"),
  );
  expect(() => deliveryTaskRequest("route", task, "host-b")).toThrow(/selected environment/);
  expect(() =>
    deliveryTaskRequest("route", { ...task, origin: "thread:host-a/" }, "host-a"),
  ).toThrow();
});

it("does not turn task or merge completion into a live deployment", () => {
  const row = {
    request: null,
    complete: false,
    publications: [
      {
        pr_url: null,
        state: "merged",
        merge: { state: "merged", problem: null, merge_commit: "abc" },
      },
    ],
    candidate: null,
    live: { commit: "old" },
  };
  expect(deliveryProgress(row)).toBe("PR merged; awaiting release qualification");
  expect(deliveryProgress({ ...row, candidate: { state: "live", commit: "abc" } })).toBe(
    "Awaiting live verification: abc",
  );
  expect(deliveryProgress({ ...row, complete: true, live: { commit: "abc" } })).toBe("Live: abc");
  expect(
    deliveryProgress({
      ...row,
      publications: [
        {
          ...row.publications[0]!,
          merge: {
            state: "merged-elsewhere",
            problem: "Merged into the wrong branch",
            merge_commit: "abc",
          },
        },
      ],
    }),
  ).toBe("Merged into the wrong branch");
});

it("rejects an old engine response instead of inventing delivery routes", () => {
  expect(parseBoardDelivery({ error: "Not found" })).toBeNull();
  expect(parseBoardDelivery({ boards: [], routes: [], projects: [], tracking: [] })).not.toBeNull();
});
