import type {
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { formatProviderDriverKindLabel } from "../providerModels";

/** A provider problem T3 shows, with what an agent needs to start diagnosing it. */
export interface ProviderProblem {
  /** The provider's name as T3 shows it. */
  readonly provider: string;
  /** The instance that has the problem, kept out of the thread that fixes it. */
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly version?: string | null | undefined;
  /** The status text exactly as shown. */
  readonly message: string;
  /** The seat or role the problem keeps from running. */
  readonly blocks?: string | undefined;
}

/** The problem a provider status banner shows, given the message it shows. */
export function providerProblemOfStatus(status: ServerProvider, message: string): ProviderProblem {
  return {
    provider: status.displayName?.trim() || formatProviderDriverKindLabel(status.driver),
    instanceId: status.instanceId,
    version: status.version,
    message,
  };
}

/** The first message of a thread that asks an agent to fix a provider problem. */
export function buildProviderProblemPrompt(problem: ProviderProblem): string {
  return [
    `T3 Code shows a problem with the ${problem.provider} provider.`,
    "",
    `Provider: ${problem.provider}`,
    ...(problem.version ? [`Version: ${problem.version}`] : []),
    `Status: ${problem.message}`,
    ...(problem.blocks ? [`Blocks: ${problem.blocks}`] : []),
    "",
    "Diagnose the cause and fix it. Run provider CLIs with the pm profile env, for example KIMI_CODE_HOME=~/.polymania/kimi.",
  ].join("\n");
}

/**
 * What the fix thread runs on: the project's default provider and model, or the first
 * healthy provider, and never the one with the problem.
 */
export function resolveProviderFixModelSelection(input: {
  readonly defaultSelection: ModelSelection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ServerSettings;
  readonly projectId: ProjectId;
  readonly broken: ProviderInstanceId | undefined;
}): ModelSelection | null {
  if (input.defaultSelection && input.defaultSelection.instanceId !== input.broken) {
    return input.defaultSelection;
  }
  return resolveProjectDefaultProviderModelSelection(
    input.providers.filter((provider) => provider.instanceId !== input.broken),
    input.settings,
    input.projectId,
  );
}
