import {
  isServerOwnedThreadLineage,
  OrchestratorMcpFailure,
  type EnvironmentId,
  type ThreadId,
  type OrchestrationV2ThreadProjection,
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

type Shell = Pick<OrchestrationV2ThreadShell, "id" | "lineage" | "creationSource">;
type Delivery = DeliveryService.DeliveryService["Service"];
type LineageReader = {
  readonly getThreadShell: (
    id: ThreadId,
  ) => Effect.Effect<
    OrchestrationV2ThreadShell | null,
    OrchestratorV2Error | ProjectionStoreV2Error
  >;
  readonly getThreadProjection: (
    id: ThreadId,
  ) => Effect.Effect<
    OrchestrationV2ThreadProjection | null,
    OrchestratorV2Error | ProjectionStoreV2Error
  >;
};
type Threads = Pick<ThreadManagement.ThreadManagementService["Service"], keyof LineageReader>;

export const isDeliveryTiedThread = Effect.fn("linkedThreadAccess.isDeliveryTiedThread")(function* (
  thread: Shell,
  threads: LineageReader,
  delivery: Delivery,
  ownerTied: ReadonlySet<ThreadId>,
) {
  const visited = new Set<ThreadId>();
  const pending = [thread];
  for (const current of pending) {
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    const { lineage } = current;
    if (
      isServerOwnedThreadLineage(lineage) ||
      boardTaskOfMarker(current.id) !== null ||
      ownerTied.has(current.id)
    )
      return true;

    const state = yield* delivery.threadState(current.id).pipe(Effect.option);
    if (Option.isNone(state) || state.value.binding !== null || state.value.pending !== null)
      return true;

    let launchedFrom = lineage.launchedFromThreadId;
    if (
      launchedFrom === undefined &&
      current.creationSource === "mcp" &&
      lineage.parentThreadId === null
    ) {
      // Launches recorded before lineage carried their creator used the first message's sender.
      const projection = yield* threads.getThreadProjection(current.id).pipe(Effect.option);
      if (Option.isNone(projection) || projection.value === null) return true;
      launchedFrom = projection.value.messages[0]?.senderThreadId;
      if (launchedFrom === undefined) return true;
    }
    for (const ancestorId of [lineage.rootThreadId, lineage.parentThreadId, launchedFrom]) {
      if (ancestorId == null || visited.has(ancestorId)) continue;
      if (boardTaskOfMarker(ancestorId) !== null || ownerTied.has(ancestorId)) return true;
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
  const listed = yield* Effect.cached(
    service.linkedThreads.pipe(
      Effect.map(
        ({ threads }) =>
          new Set(
            threads
              .filter((entry) => entry.environmentId === environmentId)
              .map(({ threadId }) => threadId),
          ),
      ),
      Effect.orElseSucceed(() => new Set<ThreadId>()),
    ),
  );
  return Effect.fn("linkedThreadAccess.canSeeThread")(function* (shell: Shell) {
    if (!(yield* isDeliveryTiedThread(shell, threads, service, ownerTied.value))) return true;
    return (yield* listed).has(shell.id);
  });
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
