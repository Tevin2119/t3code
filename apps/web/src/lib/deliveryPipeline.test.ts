import { describe, expect, it } from "vite-plus/test";

import { parseCard } from "./delivery";
import { taskPipelineStage, type TaskPipelineInput } from "./deliveryPipeline";

const publication = (extra: Record<string, unknown> = {}) => ({
  publication: "p-1",
  run: "run-1",
  task: "task-1",
  board: "original",
  projectId: "app-production",
  repositoryPath: "/real/app",
  targetBranch: "main",
  project: {
    id: "app-production",
    repository: "alias",
    path: "/real/app",
    environment: "production",
    branch: "main",
    mode: "manual",
    title: "App",
  },
  headCommit: "a".repeat(40),
  pullRequest: { number: 42, url: "https://github.com/owner/app/pull/42" },
  publicationState: "merged",
  mergeCommit: "c".repeat(40),
  state: "queued",
  problem: null,
  candidate: null,
  history: [],
  updated: "2030-01-01T00:00:00.000Z",
  ...extra,
});

const candidate = (extra: Record<string, unknown> = {}) => ({
  id: "cand-1",
  commit: "c".repeat(40),
  branch: "main",
  state: "live",
  inclusion: null,
  evidence: null,
  problem: null,
  failedPhase: null,
  liveAt: "2030-01-01T00:00:00.000Z",
  liveUntil: null,
  ...extra,
});

function task(
  lane: string,
  options: {
    readonly publications?: ReadonlyArray<string>;
    readonly deployment?: unknown;
    readonly run?: { readonly id: string; readonly stage: string } | null;
    readonly stage?: string | null;
    readonly resumesIn?: string | null;
  } = {},
): TaskPipelineInput {
  const card = parseCard({
    lane,
    deployment: options.deployment,
    stage: options.stage ?? null,
    resumesIn: options.resumesIn ?? null,
  })!;
  return {
    lane,
    publications: (options.publications ?? []).map((state) => ({ state })),
    card: {
      ...card,
      run: options.run
        ? {
            id: options.run.id,
            state: "",
            stage: options.run.stage,
            candidate: null,
            configuration: "",
          }
        : null,
    },
  };
}

const view = (input: TaskPipelineInput) => {
  const stage = taskPipelineStage(input);
  return [stage.label, stage.detail, stage.tone, stage.settled];
};

describe("taskPipelineStage", () => {
  it.each([
    ["draft", ["Spec in", "Draft", "secondary", false]],
    ["triage", ["Spec in", "Triage", "secondary", false]],
    ["ready", ["Spec in", "Ready", "secondary", false]],
    ["planning", ["Planning", null, "info", false]],
    ["implementation", ["Building", null, "info", false]],
    ["validation", ["Building", "Testing", "info", false]],
    ["human-review", ["Building", "Your sign-off", "warning", false]],
    ["rework", ["Building", "Rework", "warning", false]],
    ["approved", ["Building", "Approved, not published", "info", false]],
    ["pull-request", ["Building", "Pull request open", "info", false]],
  ])("reads the %s lane as its step", (lane, expected) => {
    expect(view(task(lane))).toEqual(expected);
  });

  it("calls a merged publication Merged, and a closed one done without a merge", () => {
    expect(view(task("completed", { publications: ["pr-open", "merged"] }))).toEqual([
      "Merged",
      null,
      "success",
      true,
    ]);
    expect(view(task("completed", { publications: ["closed"] }))).toEqual([
      "Building",
      "closed without a merge",
      "secondary",
      true,
    ]);
    expect(view(task("completed"))[1]).toBe("done, nothing merged");
  });

  it("follows the deployment once one exists for this run", () => {
    const run = { id: "run-1", stage: "checks" };
    expect(
      view(task("completed", { run, deployment: { current: publication(), history: [] } })),
    ).toEqual(["Deploying", "queued", "info", false]);
    expect(
      view(
        task("completed", {
          run,
          deployment: {
            current: publication({ state: "live", candidate: candidate() }),
            history: [],
          },
        }),
      ),
    ).toEqual(["Live", null, "success", true]);
    expect(
      view(
        task("completed", {
          run,
          deployment: { current: publication({ problem: "smoke test failed" }), history: [] },
        }),
      ),
    ).toEqual(["Deploying", "smoke test failed", "warning", false]);
  });

  it("does not call a task live from a live verdict that lacks evidence", () => {
    const stage = taskPipelineStage(
      task("completed", {
        deployment: { current: publication({ state: "live", candidate: null }), history: [] },
      }),
    );
    expect([stage.label, stage.tone]).toEqual(["Deploying", "warning"]);
    expect(stage.detail).toBe("Deployment evidence is missing.");
  });

  it("does not settle at Merged on an earlier run's merge while the task is back at work", () => {
    // The engine's task payload carries the last publication across runs, with no run id: a
    // merged publication from an earlier run stays beside a rework run that merged nothing yet.
    expect(view(task("rework", { publications: ["merged"] }))).toEqual([
      "Building",
      "Rework",
      "warning",
      false,
    ]);
    expect(view(task("implementation", { publications: ["merged"] }))).toEqual([
      "Building",
      null,
      "info",
      false,
    ]);
    expect(view(task("planning", { publications: ["merged"] }))).toEqual([
      "Planning",
      null,
      "info",
      false,
    ]);
    // Outside the work lanes a merge still settles the task.
    expect(view(task("completed", { publications: ["merged"] }))).toEqual([
      "Merged",
      null,
      "success",
      true,
    ]);
    expect(view(task("approved", { publications: ["merged"] }))).toEqual([
      "Merged",
      null,
      "success",
      true,
    ]);
  });

  it("ignores a deployment of an earlier run while a new run builds", () => {
    expect(
      view(
        task("implementation", {
          run: { id: "run-2", stage: "build" },
          deployment: {
            current: publication({ state: "live", candidate: candidate() }),
            history: [],
          },
        }),
      ),
    ).toEqual(["Building", null, "info", false]);
  });

  it("places a task that waits at the step it stands at", () => {
    expect(view(task("paused", { resumesIn: "planning" }))).toEqual([
      "Planning",
      "Paused or recovering",
      "warning",
      false,
    ]);
    expect(view(task("needs-decision", { stage: "plan" }))[0]).toBe("Planning");
    expect(view(task("needs-decision", { run: { id: "run-1", stage: "qa" } }))[0]).toBe("Building");
    expect(view(task("child-work"))).toEqual([
      "Spec in",
      "Waiting on child work",
      "warning",
      false,
    ]);
  });
});
