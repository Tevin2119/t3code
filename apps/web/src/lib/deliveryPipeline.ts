/**
 * Where a task is in the engine's flow, read from what the board already shows: its lane, its
 * publication, and its deployment. Nothing here asks a person to confirm a step; it only names
 * the step the engine has reached.
 */
import { taskDeploymentStatus } from "./boardDelivery";
import type { DeliveryCard, DeliveryPublication } from "./delivery";
import { LANE_TITLE } from "./deliveryBoard";

export const TASK_PIPELINE_STAGES = [
  "Spec in",
  "Planning",
  "Building",
  "Merged",
  "Deploying",
  "Live",
] as const;

export type TaskPipelineTone = "info" | "success" | "warning" | "secondary";

export interface TaskPipelineStage {
  /** The step reached, an index into TASK_PIPELINE_STAGES. */
  readonly index: number;
  readonly label: (typeof TASK_PIPELINE_STAGES)[number];
  /** What the step is waiting on or how it stands, in the board's own words; null for nothing. */
  readonly detail: string | null;
  readonly tone: TaskPipelineTone;
  /** The step reached is finished, and nothing further is under way. */
  readonly settled: boolean;
}

export interface TaskPipelineInput {
  readonly lane: string | null;
  readonly publications: ReadonlyArray<Pick<DeliveryPublication, "state">>;
  readonly card: Pick<DeliveryCard, "lane" | "stage" | "run" | "resumesIn" | "deployment">;
}

const SPEC_LANES = new Set(["draft", "chat", "intake", "triage", "ready"]);
const BUILD_LANES = new Set([
  "implementation",
  "validation",
  "rework",
  "human-review",
  "approved",
  "pull-request",
]);
const DEPLOYING_STATES = new Set(["queued", "qualifying", "ready", "deploying", "verifying"]);

const at = (
  index: number,
  detail: string | null,
  tone: TaskPipelineTone,
  settled = false,
): TaskPipelineStage => ({
  index,
  label: TASK_PIPELINE_STAGES[index] ?? TASK_PIPELINE_STAGES[0],
  detail,
  tone,
  settled,
});

/** The step a lane is on, or null for a lane that can be reached from any step. */
function laneIndex(lane: string): number | null {
  if (SPEC_LANES.has(lane)) return 0;
  if (lane === "planning") return 1;
  if (BUILD_LANES.has(lane)) return 2;
  return null;
}

/** The step of a run's stage: the engine's plan stage is planning, triage is still the spec. */
function runStageIndex(stage: string | null): number {
  if (stage === null) return 0;
  if (stage === "plan") return 1;
  if (stage === "triage" || stage === "admit" || stage === "chat") return 0;
  return 2;
}

export function taskPipelineStage(task: TaskPipelineInput): TaskPipelineStage {
  const lane = task.lane ?? task.card.lane;
  const runId = task.card.run?.id ?? null;
  const deployment = task.card.deployment?.current ?? null;
  // A deployment of an earlier run does not say where this run is.
  if (deployment && (runId === null || deployment.run === runId)) {
    const status = taskDeploymentStatus(deployment);
    if (status.state === "superseded") return at(3, "superseded by a newer candidate", "secondary");
    // A problem is shown whatever state it stands in: queued with a problem is blocked.
    if (status.problem) return at(4, status.problem, "warning");
    if (status.state === "live") return at(5, null, "success", true);
    if (DEPLOYING_STATES.has(status.state)) return at(4, status.state, "info");
    return at(4, status.state, "warning");
  }
  const publication = task.publications.at(-1) ?? null;
  if (publication?.state === "merged") return at(3, null, "success", true);
  if (lane === "completed") {
    return at(
      2,
      publication?.state === "closed" ? "closed without a merge" : "done, nothing merged",
      "secondary",
      true,
    );
  }
  const title = LANE_TITLE[lane] ?? lane;
  const index = laneIndex(lane);
  if (index === 0) return at(0, title, "secondary");
  if (index === 1) return at(1, null, "info");
  if (index === 2) {
    return at(
      2,
      lane === "implementation" ? null : title,
      lane === "rework" || lane === "human-review" ? "warning" : "info",
    );
  }
  // Waiting on you, on child work, or paused: the step it stands at, from where it resumes or
  // from the stage of its run.
  const resumes = lane === "paused" && task.card.resumesIn ? laneIndex(task.card.resumesIn) : null;
  return at(
    resumes ?? runStageIndex(task.card.stage ?? (task.card.run?.stage || null)),
    title,
    "warning",
  );
}
