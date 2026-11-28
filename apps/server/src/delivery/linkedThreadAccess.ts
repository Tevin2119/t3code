import {
  isServerOwnedThreadLineage,
  OrchestratorMcpFailure,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { launchAncestors, type LaunchShell } from "../orchestration-v2/threadLaunchLineage.ts";
import { callerLinkOrigin } from "../mcp/linkOrigin.ts";
import { resolveThreadReference } from "../mcp/threadAccess.ts";
import type { ProjectionStoreV2Error } from "../orchestration-v2/ProjectionStore.ts";
import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { boardTaskOfMarker } from "./boardThreadMarker.ts";
import type * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as DeliveryService from "./DeliveryService.ts";

type Delivery = DeliveryService.DeliveryService["Service"];
type LineageReader = {
  readonly getThreadShell: (
    id: ThreadId,
  ) => Effect.Effect<LaunchShell | null, OrchestratorV2Error | ProjectionStoreV2Error>;
  readonly getLegacyLaunchAncestor: (
    id: ThreadId,
  ) => Effect.Effect<ThreadId | null, OrchestratorV2Error | ProjectionStoreV2Error>;
};
type Threads = Pick<ThreadManagement.ThreadManagementService["Service"], keyof LineageReader>;

function makeThreadFence(
  threads: LineageReader,
  delivery: Delivery,
  index: DeliveryService.OwnerThreadIndexSnapshot,
  allowShared: boolean,
  scheduleCreator?: { readonly id: ThreadId; readonly shell: LaunchShell | null },
) {
  const nodes = new Map<ThreadId, LaunchShell | null>();
  const blocked = new Map<ThreadId, boolean>();
  const decisions = [new Map<ThreadId, boolean>(), new Map<ThreadId, boolean>()] as const;
  const visit = Effect.fn("linkedThreadAccess.visit")(function* (
    id: ThreadId,
    sharedTarget: boolean,
    visiting: Set<ThreadId>,
  ): Effect.fn.Return<boolean> {
    const memo = decisions[sharedTarget ? 1 : 0];
    const decision = memo.get(id);
    if (decision !== undefined) return decision;
    if (visiting.has(id)) return true;
    let shell = nodes.get(id);
    if (shell === undefined) {
      shell =
        scheduleCreator?.id === id
          ? scheduleCreator.shell
          : yield* threads.getThreadShell(id).pipe(Effect.orElseSucceed(() => null));
      nodes.set(id, shell);
    }
    const tied = index.ties.get(id);
    if (
      (scheduleCreator?.id !== id && (shell === null || shell.deletedAt !== null)) ||
      tied === false ||
      (tied === true && !sharedTarget) ||
      (index.uncertainAfter !== undefined &&
        shell !== null &&
        DateTime.toEpochMillis(shell.createdAt) >= index.uncertainAfter)
    ) {
      memo.set(id, true);
      return true;
    }
    if (tied === undefined) {
      let local = blocked.get(id);
      if (local === undefined) {
        local =
          (shell !== null && isServerOwnedThreadLineage(shell.lineage)) ||
          boardTaskOfMarker(id) !== null;
        if (!local) {
          local = yield* delivery
            .threadHasDeliveryBinding(id)
            .pipe(Effect.orElseSucceed(() => true));
        }
        blocked.set(id, local);
      }
      if (local) {
        memo.set(id, true);
        return true;
      }
    }
    visiting.add(id);
    const ancestors =
      shell === null ? Option.some([]) : yield* launchAncestors(shell, threads).pipe(Effect.option);
    let fenced = Option.isNone(ancestors);
    if (Option.isSome(ancestors)) {
      for (const ancestor of ancestors.value) {
        if (yield* visit(ancestor, sharedTarget, visiting)) {
          fenced = true;
          break;
        }
      }
    }
    visiting.delete(id);
    memo.set(id, fenced);
    return fenced;
  });
  return (target: ThreadId | LaunchShell) => {
    const id = typeof target === "string" ? target : target.id;
    if (typeof target !== "string") nodes.set(id, target);
    return visit(id, allowShared && index.ties.get(id) === true, new Set());
  };
}

export const isFencedThread = Effect.fn("linkedThreadAccess.isFencedThread")(function* (
  thread: LaunchShell,
  threads: LineageReader,
  delivery: Delivery,
  index: DeliveryService.OwnerThreadIndexSnapshot,
  allowShared: boolean,
) {
  return yield* makeThreadFence(threads, delivery, index, allowShared)(thread);
});

const notFound = () =>
  new OrchestratorMcpFailure({
    code: "thread_not_found",
    message: "The thread was not found.",
  });

const threadVisibility = Effect.fn("linkedThreadAccess.threadVisibility")(function* (
  service: Delivery,
  threads: LineageReader,
  environmentId: EnvironmentId,
) {
  const ownerTied = yield* service.ownerTiedThreads(environmentId).pipe(Effect.option);
  // The first failed owner read can hide a source thread T3 has never seen.
  if (Option.isNone(ownerTied)) return (_target: ThreadId | LaunchShell) => Effect.succeed(false);
  const fenced = makeThreadFence(threads, service, ownerTied.value, true);
  return (target: ThreadId | LaunchShell) => fenced(target).pipe(Effect.map((blocked) => !blocked));
});

export const assertPeerThreadTargets = Effect.fn("linkedThreadAccess.assertPeerThreadTargets")(
  function* (
    scope: McpInvocationContext.McpInvocationScope,
    ids: Iterable<ThreadId>,
    threads: Threads | undefined,
    delivery: Delivery | undefined,
  ) {
    if (!McpInvocationContext.isLinkedDeliveryCaller(scope)) return;
    let visible: ((shell: LaunchShell) => Effect.Effect<boolean>) | undefined;
    for (const id of ids) {
      if (threads === undefined) return yield* notFound();
      const { shell } = yield* resolveThreadReference(threads, id).pipe(Effect.mapError(notFound));
      if (shell === null || shell.deletedAt !== null) continue;
      if (delivery === undefined) return yield* notFound();
      visible ??= yield* threadVisibility(delivery, threads, scope.environmentId);
      if (!(yield* visible(shell))) return yield* notFound();
    }
  },
);

export const filterPeerThreadRows = Effect.fn("linkedThreadAccess.filterPeerThreadRows")(function* <
  A,
>(
  scope: McpInvocationContext.McpInvocationScope,
  rows: ReadonlyArray<A>,
  targetOf: (row: A) => ThreadId | LaunchShell,
  threads: LineageReader,
  delivery?: Delivery,
) {
  if (!McpInvocationContext.isLinkedDeliveryCaller(scope) || rows.length === 0) return rows;
  const service =
    delivery ?? Option.getOrUndefined(yield* Effect.serviceOption(DeliveryService.DeliveryService));
  if (service === undefined) return [];
  const visible = yield* threadVisibility(service, threads, scope.environmentId);
  return yield* Effect.filter(rows, (row) => visible(targetOf(row)));
});

export const linkedScheduleNotFound = () =>
  new OrchestratorMcpFailure({
    code: "task_not_found",
    message: "The scheduled task was not found.",
  });

type ScheduleOrigins = Pick<ScheduledTasks.ScheduledTaskService["Service"], "getLinkOrigin">;

export const filterPeerScheduledTasks = Effect.fn("linkedThreadAccess.filterPeerScheduledTasks")(
  function* (
    scope: McpInvocationContext.McpInvocationScope,
    tasks: ReadonlyArray<ScheduledTask>,
    schedules: ScheduleOrigins,
    threads: Threads,
    delivery?: Delivery,
  ) {
    if (!McpInvocationContext.isLinkedDeliveryCaller(scope)) return tasks;
    const caller = callerLinkOrigin({ scope, caller: undefined });
    if (caller === undefined || tasks.length === 0 || delivery === undefined) return [];
    const index = yield* delivery.ownerTiedThreads(scope.environmentId).pipe(Effect.option);
    if (Option.isNone(index)) return [];
    return yield* Effect.filter(tasks, (task) =>
      Effect.gen(function* () {
        const origin = yield* schedules.getLinkOrigin(task);
        if (origin?.sessionId !== caller.sessionId) return false;

        const creator = task.launchedFromThreadId;
        const source =
          creator === undefined
            ? null
            : yield* threads.getThreadShell(creator, { includeDeleted: true });
        if (task.threadId !== null && task.threadId === creator && source?.deletedAt !== null) {
          return false;
        }
        // Only a schedule with verified ownership can traverse its retired creator.
        const fenced = makeThreadFence(
          threads,
          delivery,
          index.value,
          true,
          creator === undefined ? undefined : { id: creator, shell: source },
        );
        if (creator !== undefined && (yield* fenced(creator))) return false;
        return task.threadId === null || !(yield* fenced(task.threadId));
      }).pipe(Effect.orElseSucceed(() => false)),
    );
  },
);

export const assertPeerScheduledTask = Effect.fn("linkedThreadAccess.assertPeerScheduledTask")(
  function* (
    scope: McpInvocationContext.McpInvocationScope,
    task: ScheduledTask,
    schedules: ScheduleOrigins,
    threads: Threads,
    delivery?: Delivery,
  ) {
    const allowed = yield* filterPeerScheduledTasks(scope, [task], schedules, threads, delivery);
    if (allowed.length === 0) return yield* linkedScheduleNotFound();
  },
);
