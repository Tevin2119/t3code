import {
  DeploymentCommands,
  DeploymentProjectInput,
  DeploymentDiscoverInput,
  DeploymentActionInput,
  DeploymentDependenciesInput,
  DeploymentPromotionActionInput,
  DeploymentPromotionInput,
  DeploymentsSnapshot,
  type DeploymentAction,
  type DeploymentCandidate,
  type DeploymentProject,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeCommands = Schema.decodeUnknownSync(DeploymentCommands);
const decode = Schema.decodeUnknownOption(DeploymentsSnapshot);
export const parseDeployments = (body: unknown): DeploymentsSnapshot | null =>
  Option.getOrNull(decode(body));

// The engine refuses more attempts than this; it stays authoritative, this only hides dead buttons.
const MAX_ATTEMPTS = 5;

function stateActions(candidate: DeploymentCandidate): readonly DeploymentAction[] {
  switch (candidate.state) {
    case "merged":
      return ["qualify", "cancel"];
    case "ready":
      return ["deploy", "cancel"];
    case "blocked":
      return candidate.needsVerify ? ["verify", "retry"] : ["retry", "verify", "cancel"];
    case "qualifying":
      return ["cancel"];
    case "deploying":
      return candidate.phase === "preflight" ? ["cancel"] : [];
    case "verifying":
      return candidate.awaitingRestart ? ["verify"] : [];
    case "live":
      return ["verify"];
    case "superseded":
      return [];
  }
}

// The engine's retry rule: resume, else qualify again a never-deployed candidate with no passing
// evidence (a save clears it), else deploy again on its passing evidence.
function canRetry(candidate: DeploymentCandidate): boolean {
  const passed = (candidate.evidence as { passed?: unknown } | null)?.passed === true;
  if (
    candidate.resumeState &&
    !candidate.needsVerify &&
    (candidate.resumeState !== "ready" || passed)
  )
    return true;
  const attempts = candidate.attempts ?? { qualify: 0, deploy: 0 };
  const deployed = Array.isArray(candidate.deployedTo) && candidate.deployedTo.length > 0;
  const requalify =
    candidate.failedPhase === "qualify" || (!deployed && !candidate.needsVerify && !passed);
  if (requalify) return attempts.qualify < MAX_ATTEMPTS;
  return attempts.deploy < MAX_ATTEMPTS && passed;
}

/**
 * Work of a branch the instance no longer watches is parked: the engine takes it as current work
 * again only once that branch is watched, so it offers no qualify, deploy or retry until then.
 */
export function parkedBranch(
  candidate: Pick<DeploymentCandidate, "branch">,
  watchedBranch: string | null,
): string | null {
  return candidate.branch && watchedBranch && candidate.branch !== watchedBranch
    ? candidate.branch
    : null;
}
const CURRENT_WORK: ReadonlyArray<DeploymentAction> = ["qualify", "deploy", "retry"];

// The engine adopts only from a qualified candidate, for the site its qualification resolved.
function canAdopt(candidate: DeploymentCandidate): boolean {
  const evidence = candidate.evidence as { site?: unknown } | null;
  return (
    (candidate.state === "ready" || candidate.state === "blocked") &&
    typeof evidence?.site === "string"
  );
}

/** Actions to offer; while another release for the environment runs, only stopping is offered. */
export function deploymentActions(
  candidate: DeploymentCandidate,
  projectBusy = false,
  adapter: DeploymentProject["adapter"] = "command",
  watchedBranch: string | null = null,
): readonly DeploymentAction[] {
  const parked = parkedBranch(candidate, watchedBranch) !== null;
  const actions = stateActions(candidate);
  const offered =
    adapter === "firebase-hosting" && canAdopt(candidate)
      ? [...actions, "adopt" as const]
      : actions;
  return offered.filter((action) => {
    if (parked && CURRENT_WORK.includes(action)) return false;
    if (action === "cancel") return !candidate.cancelRequested;
    if (action === "retry" && !canRetry(candidate)) return false;
    if (action === "adopt") return !projectBusy;
    if (!projectBusy) return true;
    // A restart being waited on is this candidate's own work, and verifying it is how it ends.
    return action === "verify" && candidate.state === "verifying" && !!candidate.awaitingRestart;
  });
}

/** What the running revision says, which is not the same as whether it is healthy. */
export function deploymentStatus(
  project: Pick<
    DeploymentProject,
    "latestCommit" | "liveCommit" | "liveProblem" | "liveObservedAt" | "problem"
  > &
    Partial<Pick<DeploymentProject, "adapter" | "liveCandidate">>,
  unavailable = false,
  /** The engine's live candidate, to name it as its card does. */
  liveRelease: Pick<DeploymentCandidate, "seq" | "commit"> | null = null,
): string {
  // The engine derives Firebase live state once; its words are shown as they are.
  if (project.adapter === "firebase-hosting") {
    if (project.liveProblem) return project.liveProblem;
    if (project.problem) return `Deployment problem: ${project.problem}`;
    if (unavailable) return "Runtime status unavailable. Showing last reading.";
    if (!project.liveCandidate) return "The engine reports no live release.";
    if (!liveRelease) return `Live: release ${project.liveCandidate}`;
    const label = liveRelease.seq !== undefined ? `Release #${liveRelease.seq}` : "Release";
    return `Live: ${label} · ${liveRelease.commit.slice(0, 10)}`;
  }
  if (project.liveProblem) return `Running revision problem: ${project.liveProblem}`;
  if (project.problem) return `Deployment problem: ${project.problem}`;
  if (unavailable) return "Runtime status unavailable. Showing last reading.";
  const observed = !!project.liveObservedAt && Number.isFinite(Date.parse(project.liveObservedAt));
  if (project.liveCommit === null) {
    return observed ? "No revision deployed at last observation" : "Running revision is unknown";
  }
  if (!observed) return "Runtime observation time is unknown";
  if (project.latestCommit === null) return "No merged revision discovered";
  return project.liveCommit === project.latestCommit
    ? "Running revision matches latest merge"
    : "Running revision differs from latest merge";
}

export function parseDeploymentCommands(text: string): {
  commands: typeof DeploymentCommands.Type | null;
  problem: string | null;
} {
  if (!text.trim()) return { commands: null, problem: null };
  try {
    const commands = decodeCommands(JSON.parse(text));
    return { commands, problem: null };
  } catch {
    return {
      commands: null,
      problem:
        "Enter a JSON object with nonempty qualify, deploy and verify argument arrays, and optional setup.",
    };
  }
}

const decodeProject = Schema.decodeUnknownSync(DeploymentProjectInput);
const decodeDiscover = Schema.decodeUnknownSync(DeploymentDiscoverInput);
const decodeAction = Schema.decodeUnknownSync(DeploymentActionInput);
const decodeDependencies = Schema.decodeUnknownSync(DeploymentDependenciesInput);
const decodePromotion = Schema.decodeUnknownSync(DeploymentPromotionInput);
const decodePromotionAction = Schema.decodeUnknownSync(DeploymentPromotionActionInput);

export function deploymentRequestBody(path: string, body: unknown): unknown {
  if (path === "/api/deployments/projects") return decodeProject(body);
  if (path === "/api/deployments/discover") return decodeDiscover(body);
  if (/^\/api\/deployments\/candidates\/[A-Za-z0-9_-]+\/action$/.test(path))
    return decodeAction(body);
  if (/^\/api\/deployments\/candidates\/[A-Za-z0-9_-]+\/dependencies$/.test(path))
    return decodeDependencies(body);
  if (path === "/api/deployments/promotions") return decodePromotion(body);
  if (/^\/api\/deployments\/promotions\/[\w-]+\/action$/.test(path))
    return decodePromotionAction(body);
  throw new Error("Unsupported deployment action");
}
