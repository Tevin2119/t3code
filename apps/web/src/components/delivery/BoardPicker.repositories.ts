import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { parseRepositories, type DeliveryRepository } from "../../lib/delivery";
import { normalizeProjectPathForComparison } from "@t3tools/client-runtime/state/projects";

/** Option values of T3 projects start with this, so they never clash with an engine id. */
export const PROJECT_CHOICE_PREFIX = "__t3_project__:";

/** One row of the board's Repository list. */
export type RepositoryChoice =
  | { readonly kind: "engine"; readonly value: string; readonly repository: DeliveryRepository }
  | {
      readonly kind: "project";
      readonly value: string;
      readonly name: string;
      readonly folder: string;
    };

/** The name a T3 project is known by: its repository's, else its own title. */
export function projectRepositoryName(
  project: Pick<EnvironmentProject, "title" | "repositoryIdentity">,
): string {
  const identity = project.repositoryIdentity;
  return identity?.displayName?.trim() || identity?.name?.trim() || project.title;
}

/** The engine's repositories, with those the engine has just added and not yet listed. */
export function knownRepositories(
  read: ReadonlyArray<DeliveryRepository>,
  added: ReadonlyArray<DeliveryRepository>,
): ReadonlyArray<DeliveryRepository> {
  const ids = new Set(read.map((item) => item.id));
  return [...read, ...added.filter((item) => !ids.has(item.id))];
}

/**
 * The Repository list: every engine repository a board can use, then each of the environment's
 * T3 projects whose folder the engine does not have yet. A project in a folder the engine already
 * has is that repository's row, and one in a qualification repository's folder is not offered.
 */
export function repositoryChoices(input: {
  readonly repositories: ReadonlyArray<DeliveryRepository>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentId: EnvironmentId | null | undefined;
}): ReadonlyArray<RepositoryChoice> {
  const engine: Array<RepositoryChoice> = input.repositories
    .filter((item) => item.kind !== "qualification")
    .map((repository) => ({ kind: "engine", value: repository.id, repository }));
  const taken = new Set(
    input.repositories.map((item) => normalizeProjectPathForComparison(item.path)).filter(Boolean),
  );
  const projects: Array<RepositoryChoice> = [];
  for (const project of input.projects) {
    if (!input.environmentId || project.environmentId !== input.environmentId) continue;
    const folder = normalizeProjectPathForComparison(project.workspaceRoot);
    if (!folder || taken.has(folder)) continue;
    taken.add(folder);
    projects.push({
      kind: "project",
      value: `${PROJECT_CHOICE_PREFIX}${project.id}`,
      name: projectRepositoryName(project),
      folder: project.workspaceRoot,
    });
  }
  return [...engine, ...projects];
}

/**
 * The repository the engine says it added, or null when its reply names none. The submitted
 * folder and name stand in for what the reply leaves out, and the default base is a branch.
 */
export function addedRepository(
  body: unknown,
  submitted: { readonly path: string; readonly title: string },
): DeliveryRepository | null {
  const made = parseRepositories([body])[0];
  if (!made || !made.id.trim()) return null;
  const record = body as Record<string, unknown>;
  const defaultBase = made.defaultBase?.trim() ? made.defaultBase : null;
  const branches =
    defaultBase && !made.branches.includes(defaultBase)
      ? [defaultBase, ...made.branches]
      : made.branches;
  return {
    ...made,
    defaultBase,
    title: typeof record.title === "string" && record.title.trim() ? made.title : submitted.title,
    path: made.path || submitted.path,
    branches,
    // A reply that does not say otherwise is taken as a repository that can be read.
    ok: record.ok === undefined ? true : made.ok,
  };
}

/**
 * The engine repository a choice stands for, for a row made before the engine listed its folder:
 * a project chosen again once it has been added is that repository, and is not added twice.
 */
export function repositoryInFolder(
  repositories: ReadonlyArray<DeliveryRepository>,
  folder: string,
): DeliveryRepository | null {
  const wanted = normalizeProjectPathForComparison(folder);
  if (!wanted) return null;
  return (
    repositories.find(
      (item) =>
        item.kind !== "qualification" && normalizeProjectPathForComparison(item.path) === wanted,
    ) ?? null
  );
}
