import {
  DeploymentCommands,
  DeploymentProjectInput,
  DeploymentDiscoverInput,
  DeploymentActionInput,
  DeploymentDependenciesInput,
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

function canRetry(candidate: DeploymentCandidate): boolean {
  if (candidate.resumeState && !candidate.needsVerify) return true;
  const attempts = candidate.attempts ?? { qualify: 0, deploy: 0 };
  if (candidate.failedPhase === "qualify") return attempts.qualify < MAX_ATTEMPTS;
  const evidence = candidate.evidence as { passed?: unknown } | null;
  return attempts.deploy < MAX_ATTEMPTS && evidence?.passed === true;
}

/** Actions to offer; while another release for the environment runs, only stopping is offered. */
export function deploymentActions(
  candidate: DeploymentCandidate,
  projectBusy = false,
): readonly DeploymentAction[] {
  return stateActions(candidate).filter((action) => {
    if (action === "cancel") return !candidate.cancelRequested;
    if (action === "retry" && !canRetry(candidate)) return false;
    if (!projectBusy) return true;
    // A restart being waited on is this candidate's own work, and verifying it is how it ends.
    return action === "verify" && candidate.state === "verifying" && !!candidate.awaitingRestart;
  });
}

/** What the running revision says, which is not the same as whether it is healthy. */
export function deploymentStatus(
  project: Pick<DeploymentProject, "latestCommit" | "liveCommit" | "liveProblem">,
): string {
  if (project.liveProblem) return `Running revision problem: ${project.liveProblem}`;
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

export function deploymentRequestBody(path: string, body: unknown): unknown {
  if (path === "/api/deployments/projects") return decodeProject(body);
  if (path === "/api/deployments/discover") return decodeDiscover(body);
  if (/^\/api\/deployments\/candidates\/[A-Za-z0-9_-]+\/action$/.test(path))
    return decodeAction(body);
  if (/^\/api\/deployments\/candidates\/[A-Za-z0-9_-]+\/dependencies$/.test(path))
    return decodeDependencies(body);
  throw new Error("Unsupported deployment action");
}
