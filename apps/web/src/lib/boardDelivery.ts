import {
  BoardDeploymentInput,
  BoardDeploymentLink,
  MergePermissionInput,
  MergePermissionView,
  TaskDeployment,
  type TaskDeploymentPublication,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const link = Schema.decodeUnknownOption(BoardDeploymentLink);
const permission = Schema.decodeUnknownOption(MergePermissionView);
const deployment = Schema.decodeUnknownOption(TaskDeployment);
export const parseBoardDeployment = (value: unknown) => Option.getOrNull(link(value));
export const parseMergePermission = (value: unknown) => Option.getOrNull(permission(value));
export const parseTaskDeployment = (value: unknown) => Option.getOrNull(deployment(value));

const decodeLink = Schema.decodeUnknownSync(BoardDeploymentInput, { onExcessProperty: "error" });
const decodePermission = Schema.decodeUnknownSync(MergePermissionInput, {
  onExcessProperty: "error",
});
export function boardDeliveryRequest(path: string, body: unknown): unknown {
  if (/^\/api\/boards\/[\w-]+\/deployment$/.test(path)) return decodeLink(body);
  if (/^\/api\/(engine|boards\/[\w-]+|tasks\/[\w-]+)\/merge-permission$/.test(path))
    return decodePermission(body);
  throw new Error("Unsupported board delivery action");
}

const states = new Set([
  "queued",
  "qualifying",
  "ready",
  "deploying",
  "verifying",
  "live",
  "blocked",
  "superseded",
]);
export function taskDeploymentStatus(publication: TaskDeploymentPublication) {
  const problem = publication.problem ?? publication.candidate?.problem;
  if (problem)
    return {
      state: ["queued", "superseded", "blocked"].includes(publication.state)
        ? publication.state
        : "blocked",
      problem,
    };
  if (!states.has(publication.state))
    return { state: "unknown", problem: "The engine returned an unknown deployment state." };
  if (
    ["live", "ready"].includes(publication.state) &&
    (!publication.mergeCommit || !publication.candidate)
  )
    return { state: "unknown", problem: "Deployment evidence is missing." };
  if (
    publication.state === "live" &&
    (!publication.candidate?.liveAt || publication.candidate.liveUntil)
  )
    return { state: "unknown", problem: "Current runtime verification evidence is missing." };
  return { state: publication.state, problem: publication.candidate?.problem ?? null };
}

export function taskDeploymentLabel(deployment: TaskDeployment, run: string | null) {
  const current = deployment.current;
  const old = current.run !== run;
  return `${old ? "Earlier run" : "Deployment"}: ${taskDeploymentStatus(current).state} · ${current.project?.environment ?? "unknown environment"}`;
}

const Route = Schema.Struct({
  id: Schema.String,
  board: Schema.String,
  repository: Schema.String,
  base: Schema.String,
  project: Schema.String,
  auto_merge: Schema.Number,
});
const Tracking = Schema.Struct({
  request: Schema.NullOr(
    Schema.Struct({ id: Schema.String, origin: Schema.String, task: Schema.String }),
  ),
  complete: Schema.Boolean,
  publications: Schema.Array(
    Schema.Struct({
      pr_url: Schema.NullOr(Schema.String),
      state: Schema.String,
      merge: Schema.NullOr(
        Schema.Struct({
          state: Schema.String,
          problem: Schema.NullOr(Schema.String),
          merge_commit: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  ),
  candidate: Schema.NullOr(Schema.Struct({ state: Schema.String, commit: Schema.String })),
  live: Schema.NullOr(Schema.Struct({ commit: Schema.NullOr(Schema.String) })),
});
const Snapshot = Schema.Struct({
  problem: Schema.optional(Schema.NullOr(Schema.String)),
  boards: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      repository: Schema.NullOr(Schema.String),
      base: Schema.NullOr(Schema.String),
    }),
  ),
  routes: Schema.Array(Route),
  projects: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      repository: Schema.String,
      branch: Schema.String,
      environment: Schema.String,
      mode: Schema.String,
    }),
  ),
  tracking: Schema.Array(Tracking),
});
const decodeSnapshot = Schema.decodeUnknownOption(Snapshot);
export const parseBoardDelivery = (value: unknown) => Option.getOrNull(decodeSnapshot(value));

export function deliveryProgress(row: typeof Tracking.Type): string {
  const merge = row.publications.at(-1)?.merge;
  if (merge?.problem) return merge.problem;
  if (row.complete) return `Live: ${row.live?.commit ?? "revision unavailable"}`;
  if (row.candidate?.state === "live") return `Awaiting live verification: ${row.candidate.commit}`;
  if (row.candidate) return `Release ${row.candidate.state}: ${row.candidate.commit}`;
  if (merge?.state === "merged") return "PR merged; awaiting release qualification";
  if (row.publications.length) return "PR open; awaiting host merge";
  return "Task submitted; awaiting pull request";
}

export function deliveryTaskRequest(
  route: string,
  task: { id: string; origin: string },
  environment: string,
) {
  if (
    !task.origin.startsWith(`thread:${environment}/`) ||
    !task.origin.slice(`thread:${environment}/`.length).trim()
  ) {
    throw new Error("This task needs an originating thread in the selected environment.");
  }
  return { id: `delivery-${task.id}`, route, task: task.id, origin: task.origin };
}
