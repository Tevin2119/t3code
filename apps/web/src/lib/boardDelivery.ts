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
