import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { filterPeerThreadRows } from "./linkedThreadAccess.ts";
import * as DeliveryService from "./DeliveryService.ts";

it.effect("reads each thread in a launch chain once per linked list", () =>
  Effect.gen(function* () {
    const scope = {
      environmentId: EnvironmentId.make("receiver"),
      capabilities: new Set<never>(),
      issuedAt: 0,
      requestNamespace: "peer",
      thread: undefined,
      client: { sessionId: "peer", label: "Peer", access: "full-access", linked: true },
    } as const;
    const ids = Array.from({ length: 60 }, (_, index) => ThreadId.make(`launch:${index}`));
    const shells = new Map(
      ids.map((id, index) => [
        id,
        {
          id,
          deletedAt: null,
          createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
          creationSource: "mcp" as const,
          lineage: {
            rootThreadId: id,
            parentThreadId: null,
            relationshipToParent: null,
            launchedFromThreadId: ids[index - 1] ?? null,
          },
        },
      ]),
    );
    let shellReads = 0;
    let bindingReads = 0;
    const threads = {
      getLegacyLaunchAncestor: () => Effect.succeed(null),
      getThreadShell: (id: ThreadId) =>
        Effect.sync(() => {
          shellReads++;
          return shells.get(id) ?? null;
        }),
    };
    const service = yield* DeliveryService.DeliveryService;
    const visible = yield* filterPeerThreadRows(scope, ids.toReversed(), (id) => id, threads, {
      ...service,
      threadHasDeliveryBinding: () =>
        Effect.sync(() => {
          bindingReads++;
          return false;
        }),
    });
    expect(visible).toEqual(ids.toReversed());
    expect(bindingReads).toBe(ids.length);
    expect(shellReads).toBe(ids.length);
  }).pipe(Effect.provide(DeliveryService.layerTestWithThreadIndex({}))),
);
