import {
  DeploymentCommands,
  DeploymentProjectInput,
  DeploymentDiscoverInput,
  DeploymentActionInput,
  DeploymentDependenciesInput,
  DeploymentsSnapshot,
  type DeploymentAction,
  type DeploymentCandidate,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeCommands = Schema.decodeUnknownSync(DeploymentCommands);
const decode = Schema.decodeUnknownOption(DeploymentsSnapshot);
export const parseDeployments = (body: unknown): DeploymentsSnapshot | null =>
  Option.getOrNull(decode(body));

export function deploymentActions(
  state: DeploymentCandidate["state"],
  phase?: string | null,
  needsVerify = false,
  awaitingRestart = false,
): readonly DeploymentAction[] {
  switch (state) {
    case "merged":
      return ["qualify", "cancel"];
    case "ready":
      return ["deploy", "cancel"];
    case "blocked":
      return needsVerify ? ["verify", "retry"] : ["retry", "verify", "cancel"];
    case "qualifying":
      return ["cancel"];
    case "deploying":
      return phase === "preflight" ? ["cancel"] : [];
    case "verifying":
      return awaitingRestart ? ["verify"] : [];
    case "live":
      return ["verify"];
    case "superseded":
      return [];
  }
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
