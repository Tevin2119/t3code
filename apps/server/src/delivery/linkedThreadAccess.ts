import {
  isServerOwnedThreadLineage,
  OrchestratorMcpFailure,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { resolveThreadReference } from "../mcp/threadAccess.ts";
import type { ProjectionStoreV2Error } from "../orchestration-v2/ProjectionStore.ts";
import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { boardTaskOfMarker } from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";

type Shell = Pick<OrchestrationV2ThreadShell, "id" | "lineage">;
type Delivery = DeliveryService.DeliveryService["Service"];
type LineageReader = {
  readonly getThreadShell: (
    id: ThreadId,
  ) => Effect.Effect<
    OrchestrationV2ThreadShell | null,
    OrchestratorV2Error | ProjectionStoreV2Error
  >;
};
type Threads = Pick<ThreadManagement.ThreadManagementService["Service"], keyof LineageReader>;

export const isFencedThread = Effect.fn("linkedThreadAccess.isFencedThread")(function* (
  thread: Shell,
  threads: LineageReader,
  delivery: Delivery,
  ownerTied: ReadonlyMap<ThreadId, boolean>,
  allowShared: boolean,
) {
  const sharedTarget = allowShared && ownerTied.get(thread.id) === true;
  const visited = new Set<ThreadId>();
  const pending = [thread];
  for (const current of pending) {
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    const { lineage } = current;
    const linked = ownerTied.get(current.id);
    if (linked === false || (linked === true && !sharedTarget)) return true;
    if (linked === undefined) {
      if (isServerOwnedThreadLineage(lineage) || boardTaskOfMarker(current.id) !== null)
        return true;
      const state = yield* delivery.threadState(current.id).pipe(Effect.option);
      if (Option.isNone(state) || state.value.binding !== null || state.value.pending !== null)
        return true;
    }

    for (const ancestorId of [
      lineage.rootThreadId,
      lineage.parentThreadId,
      lineage.launchedFromThreadId,
    ]) {
      if (ancestorId == null || visited.has(ancestorId)) continue;
      const ancestor = yield* threads.getThreadShell(ancestorId).pipe(Effect.option);
      if (Option.isNone(ancestor) || ancestor.value === null) return true;
      pending.push(ancestor.value);
    }
  }
  return false;
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
  if (Option.isNone(ownerTied)) return (_shell: Shell) => Effect.succeed(false);
  return (shell: Shell) =>
    isFencedThread(shell, threads, service, ownerTied.value, true).pipe(
      Effect.map((fenced) => !fenced),
    );
});

export const assertPeerThreadTargets = Effect.fn("linkedThreadAccess.assertPeerThreadTargets")(
  function* (
    scope: McpInvocationContext.McpInvocationScope,
    ids: Iterable<ThreadId>,
    threads: Threads | undefined,
    delivery: Delivery | undefined,
  ) {
    if (!McpInvocationContext.isLinkedDeliveryCaller(scope)) return;
    let visible: ((shell: Shell) => Effect.Effect<boolean>) | undefined;
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
  shellOf: (row: A) => Effect.Effect<Shell | null>,
  threads: LineageReader,
  delivery?: Delivery,
) {
  if (!McpInvocationContext.isLinkedDeliveryCaller(scope) || rows.length === 0) return rows;
  const service =
    delivery ?? Option.getOrUndefined(yield* Effect.serviceOption(DeliveryService.DeliveryService));
  if (service === undefined) return [];
  const visible = yield* threadVisibility(service, threads, scope.environmentId);
  return yield* Effect.filter(
    rows,
    (row) =>
      shellOf(row).pipe(
        Effect.flatMap((shell) => (shell === null ? Effect.succeed(false) : visible(shell))),
      ),
    { concurrency: 8 },
  );
});

export const scheduledTaskThreadTargets = (task: ScheduledTask): ThreadId[] => [
  ...new Set([task.threadId, task.launchedFromThreadId].filter((id) => id != null)),
];

export const assertPeerScheduledTask = Effect.fn("linkedThreadAccess.assertPeerScheduledTask")(
  function* (
    scope: McpInvocationContext.McpInvocationScope,
    task: ScheduledTask,
    threads: LineageReader,
    delivery?: Delivery,
  ) {
    const ids = scheduledTaskThreadTargets(task);
    const allowed = yield* filterPeerThreadRows(
      scope,
      ids,
      (id) =>
        threads.getThreadShell(id).pipe(
          Effect.map((shell) => (shell?.deletedAt === null ? shell : null)),
          Effect.orElseSucceed(() => null),
        ),
      threads,
      delivery,
    );
    if (allowed.length !== ids.length) return yield* notFound();
  },
);
