import {
  isListedThreadLineage,
  isServerOwnedThreadLineage,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type ProjectId,
} from "@t3tools/contracts";

import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/**
 * The threads of these projects that the server started for itself, such as a board task's
 * conversation. The shell leaves their rows out and counts them instead, as of its last snapshot;
 * a server that does not count sends every row, so the larger of the two is used.
 */
export function serverOwnedThreadCount(input: {
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }>;
  readonly counted: (
    environmentId: EnvironmentId,
  ) => OrchestrationV2ShellSnapshot["serverOwnedThreads"];
  /** The rows this client holds. */
  readonly threads: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "lineage">
  >;
}): number {
  let total = 0;
  for (const member of input.members) {
    const counted =
      input.counted(member.environmentId)?.find((entry) => entry.projectId === member.id)?.count ??
      0;
    const held = input.threads.filter(
      (thread) =>
        thread.environmentId === member.environmentId &&
        thread.projectId === member.id &&
        isServerOwnedThreadLineage(thread.lineage),
    ).length;
    total += Math.max(counted, held);
  }
  return total;
}

export function planProjectRemoval<
  Thread extends Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "lineage">,
>(
  options: {
    readonly members: ReadonlyArray<
      Pick<EnvironmentProject, "id" | "environmentId" | "title" | "workspaceRoot"> & {
        readonly environmentLabel?: string | null;
      }
    >;
    readonly groupMemberCount: number;
    readonly hasOtherMembers: boolean;
    readonly displayName: string;
    readonly threads: ReadonlyArray<Thread>;
    /** The members' threads this client does not hold: older settled threads its shell left out. */
    readonly unloadedThreadCount?: number;
    /** The members' server-owned threads, which are archived, not deleted: `serverOwnedThreadCount`. */
    readonly serverOwnedThreadCount?: number;
  },
  resolve: MFunctionType = mFallback,
) {
  const { members, groupMemberCount, hasOtherMembers, displayName, threads } = options;
  const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
  const projectThreads = threads.filter((thread) =>
    memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
  );
  // Side chats and subagents go with their parent but never show in thread lists.
  const threadCount =
    projectThreads.filter((thread) => isListedThreadLineage(thread.lineage)).length +
    (options.unloadedThreadCount ?? 0);
  const keptCount = options.serverOwnedThreadCount ?? 0;
  const isWholeGroup = members.length === groupMemberCount;
  const targetKind = hasOtherMembers || !isWholeGroup ? "checkout" : "project";
  const singleMember = members.length === 1 ? members[0]! : null;
  const targetLabel = singleMember?.title ?? displayName;
  const confirmationMessage = [
    threadCount > 0
      ? targetKind === "checkout"
        ? resolve(
            msg(
              '{count, plural, one {Remove checkout "{label}" and delete its {count} thread?} other {Remove checkout "{label}" and delete its {count} threads?}}',
              { count: threadCount, label: targetLabel },
            ),
          )
        : resolve(
            msg(
              '{count, plural, one {Remove project "{label}" and delete its {count} thread?} other {Remove project "{label}" and delete its {count} threads?}}',
              { count: threadCount, label: targetLabel },
            ),
          )
      : targetKind === "checkout"
        ? resolve(msg('Remove checkout "{label}"?', { label: targetLabel }))
        : resolve(msg('Remove project "{label}"?', { label: targetLabel })),
    ...(singleMember
      ? [
          resolve(msg("Path: {path}", { path: singleMember.workspaceRoot })),
          ...(singleMember.environmentLabel
            ? [
                resolve(
                  msg("Environment: {environment}", {
                    environment: singleMember.environmentLabel,
                  }),
                ),
              ]
            : []),
        ]
      : [resolve(msg("This removes {count} grouped project entries.", { count: members.length }))]),
    ...(threadCount > 0
      ? [
          resolve(
            msg(
              "Those threads and any archived threads are deleted from T3 Code. Provider sessions are kept.",
            ),
          ),
        ]
      : [
          resolve(
            msg("Any archived threads are deleted from T3 Code. Provider sessions are kept."),
          ),
        ]),
    // No list shows these, so this line is the only place a person learns they exist. Its last
    // sentence is the exception to "any archived threads are deleted" above.
    ...(keptCount > 0
      ? [
          resolve(
            msg(
              "{count, plural, one {{count} conversation started by a board or the engine is archived, not deleted.} other {{count} conversations started by a board or the engine are archived, not deleted.}} Board and engine conversations already archived are kept.",
              { count: keptCount },
            ),
          ),
        ]
      : []),
    isWholeGroup && !hasOtherMembers
      ? resolve(msg("This removes only the project entries, not the files on disk."))
      : resolve(msg("Other entries in this grouped project are unaffected.")),
    resolve(msg("This action cannot be undone.")),
  ].join("\n");

  return { projectThreads, isWholeGroup, targetKind, confirmationMessage };
}
