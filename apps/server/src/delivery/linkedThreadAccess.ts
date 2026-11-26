import {
  isServerOwnedThreadLineage,
  OrchestratorMcpFailure,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { resolveThreadReference } from "../mcp/threadAccess.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { boardTaskOfMarker } from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";

type Shell = Pick<OrchestrationV2ThreadShell, "id" | "lineage">;
type Delivery = DeliveryService.DeliveryService["Service"];
type Threads = Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadShell">;

export const isDeliveryTiedThread = Effect.fn("linkedThreadAccess.isDeliveryTiedThread")(function* (
  thread: Shell,
  delivery: Delivery | undefined,
) {
  if (
    isServerOwnedThreadLineage(thread.lineage) ||
    boardTaskOfMarker(thread.id) !== null ||
    boardTaskOfMarker(thread.lineage.rootThreadId) !== null
  )
    return true;
  if (delivery === undefined) return true;
  const hasBinding = (id: ThreadId) =>
    delivery.threadState(id).pipe(
      Effect.map(({ binding }) => binding !== null),
      Effect.orElseSucceed(() => true),
    );
  if (yield* hasBinding(thread.id)) return true;
  return (
    thread.lineage.rootThreadId !== thread.id && (yield* hasBinding(thread.lineage.rootThreadId))
  );
});

const notFound = () =>
  new OrchestratorMcpFailure({
    code: "thread_not_found",
    message: "The thread was not found.",
  });

const listedThreads = Effect.fn("linkedThreadAccess.listedThreads")(function* (
  service: Delivery,
  environmentId: McpInvocationContext.McpInvocationScope["environmentId"],
) {
  return yield* service.linkedThreads.pipe(
    Effect.map(
      ({ threads }) =>
        new Set(
          threads
            .filter((entry) => entry.environmentId === environmentId)
            .map(({ threadId }) => threadId),
        ),
    ),
    Effect.orElseSucceed(() => new Set<ThreadId>()),
  );
});

export const assertPeerThreadTargets = Effect.fn("linkedThreadAccess.assertPeerThreadTargets")(
  function* (
    scope: McpInvocationContext.McpInvocationScope,
    ids: Iterable<ThreadId>,
    threads: Threads | undefined,
    delivery: Delivery | undefined,
  ) {
    if (scope.client?.linked !== true) return;
    let listed: ReadonlySet<ThreadId> | undefined;
    for (const id of ids) {
      if (threads === undefined) return yield* notFound();
      const { shell } = yield* resolveThreadReference(threads, id).pipe(Effect.mapError(notFound));
      if (shell === null || shell.deletedAt !== null) continue;
      if (!(yield* isDeliveryTiedThread(shell, delivery))) continue;
      if (delivery === undefined) return yield* notFound();
      listed ??= yield* listedThreads(delivery, scope.environmentId);
      if (!listed.has(shell.id)) return yield* notFound();
    }
  },
);

export const filterPeerThreadRows = Effect.fn("linkedThreadAccess.filterPeerThreadRows")(function* <
  A,
>(
  scope: McpInvocationContext.McpInvocationScope,
  rows: ReadonlyArray<A>,
  shellOf: (row: A) => Effect.Effect<Shell | null>,
  delivery?: Delivery,
) {
  if (scope.client?.linked !== true) return rows;
  const service =
    delivery ?? Option.getOrUndefined(yield* Effect.serviceOption(DeliveryService.DeliveryService));
  if (service === undefined) return [];
  const shells = yield* Effect.forEach(
    rows,
    (row) =>
      Effect.gen(function* () {
        const shell = yield* shellOf(row);
        const tied = shell === null || (yield* isDeliveryTiedThread(shell, service));
        return { row, shell, tied };
      }),
    { concurrency: 8 },
  );
  if (!shells.some(({ tied, shell }) => tied && shell !== null)) {
    return shells.filter(({ tied }) => !tied).map(({ row }) => row);
  }
  const allowed = yield* listedThreads(service, scope.environmentId);
  return shells
    .filter(({ tied, shell }) => !tied || (shell !== null && allowed.has(shell.id)))
    .map(({ row }) => row);
});
