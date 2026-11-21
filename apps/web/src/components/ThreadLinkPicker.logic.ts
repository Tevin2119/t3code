import {
  isServerOwnedThreadLineage,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
} from "@t3tools/contracts";

import { normalizeSearchText } from "~/lib/utils";

export function threadLinkMatcher(query: string, locale?: string) {
  const localQuery = query.trim().toLocaleLowerCase(locale);
  const foldedQuery = normalizeSearchText(query);
  return (text: string) =>
    text.toLocaleLowerCase(locale).includes(localQuery) ||
    normalizeSearchText(text).includes(foldedQuery);
}

/** The threads a person can link, newest first. Server-owned work is never offered. */
export function threadLinkCandidates<
  Thread extends {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly archivedAt: unknown;
    readonly updatedAt: string;
    readonly lineage: OrchestrationV2ThreadShell["lineage"];
  },
>(
  threads: ReadonlyArray<Thread>,
  environmentId: EnvironmentId,
  projectNames: ReadonlyMap<ProjectId, string>,
  query: string,
): ReadonlyArray<Thread> {
  const matches = threadLinkMatcher(query);
  return threads
    .filter(
      (thread) =>
        thread.environmentId === environmentId &&
        thread.archivedAt === null &&
        !isServerOwnedThreadLineage(thread.lineage) &&
        matches(`${thread.title} ${projectNames.get(thread.projectId) ?? ""}`),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
