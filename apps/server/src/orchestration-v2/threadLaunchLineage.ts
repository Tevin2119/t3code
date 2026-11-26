import type {
  OrchestrationV2LinkOrigin,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export type LaunchShell = Pick<
  OrchestrationV2ThreadShell,
  "id" | "lineage" | "creationSource" | "createdAt" | "deletedAt"
>;

type LegacyReader<E> = {
  readonly getLegacyLaunchAncestor: (id: ThreadId) => Effect.Effect<ThreadId | null, E>;
};

export const launchAncestors = Effect.fn("threadLaunchLineage.launchAncestors")(function* <E>(
  shell: LaunchShell,
  threads: LegacyReader<E>,
) {
  const { lineage } = shell;
  const launch =
    lineage.launchedFromThreadId === undefined &&
    lineage.parentThreadId === null &&
    shell.creationSource === "mcp"
      ? yield* threads.getLegacyLaunchAncestor(shell.id)
      : lineage.launchedFromThreadId;
  return [...new Set([lineage.parentThreadId, launch, lineage.rootThreadId])].filter(
    (id): id is ThreadId => id != null && id !== shell.id,
  );
});

export const resolveLinkOrigin = Effect.fn("threadLaunchLineage.resolveLinkOrigin")(function* <E>(
  shell: OrchestrationV2ThreadShell,
  threads: LegacyReader<E> & {
    readonly getThreadShell: (
      id: ThreadId,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<OrchestrationV2ThreadShell | null, E>;
  },
): Effect.fn.Return<{ linkOrigin?: OrchestrationV2LinkOrigin; unknown?: true }, E> {
  const visited = new Set([shell.id]);
  const pending = [shell];
  let unknown = false;
  for (const current of pending) {
    if (current.linkOrigin !== undefined) return { linkOrigin: current.linkOrigin };
    for (const id of yield* launchAncestors(current, threads)) {
      if (visited.has(id)) continue;
      visited.add(id);
      const ancestor = yield* threads.getThreadShell(id, { includeDeleted: true });
      if (ancestor === null) unknown = true;
      else pending.push(ancestor);
    }
  }
  return unknown ? { unknown } : {};
});
