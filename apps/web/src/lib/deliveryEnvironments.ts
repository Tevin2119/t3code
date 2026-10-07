import type { EnvironmentWorkspace } from "@t3tools/contracts";

interface WorkspaceEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly displayUrl: string | null;
  readonly serverConfig?: {
    readonly environment: { readonly workspace?: EnvironmentWorkspace };
  } | null;
}

export function environmentWorkspaceLabel(environment: WorkspaceEnvironment): string {
  const workspace = environment.serverConfig?.environment.workspace;
  return workspace ? `${workspace.machineLabel} / ${workspace.profileLabel}` : environment.label;
}

export function groupWorkspaceEnvironments<Environment extends WorkspaceEnvironment>(
  environments: readonly Environment[],
  query: string,
) {
  const groups = new Map<string, { id: string; label: string; environments: Environment[] }>();
  for (const environment of environments) {
    if (!matchesEnvironmentSearch(environment, query)) continue;
    const workspace = environment.serverConfig?.environment.workspace;
    const id = workspace
      ? `machine:${workspace.machineId}`
      : `environment:${environment.environmentId}`;
    const group = groups.get(id) ?? {
      id,
      label: workspace?.machineLabel ?? environment.label,
      environments: [],
    };
    group.environments.push(environment);
    groups.set(id, group);
  }
  return [...groups.values()];
}

export function matchesEnvironmentSearch(
  environment: Pick<WorkspaceEnvironment, "label" | "displayUrl" | "serverConfig">,
  query: string,
): boolean {
  const workspace = environment.serverConfig?.environment.workspace;
  const searchable =
    `${environment.label} ${environment.displayUrl ?? ""} ${workspace?.machineLabel ?? ""} ${workspace?.profileLabel ?? ""}`.toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((word) => searchable.includes(word));
}
