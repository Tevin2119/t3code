import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import { readThread } from "./threadAccess.ts";

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: { sessionId: "thread-access", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const readBare = (existing: ReadonlyArray<ThreadId>) =>
  readThread(bareId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, client),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(existing.includes(threadId) ? liveThreadShell(threadId) : null),
      }),
    ),
  );

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(`The thread was not found. Did you mean \`mcp:${bareId}\`?`);
  }),
);

it.effect.each(["live", "unknown", "deleted", "empty", "malformed"] as const)(
  "resolves a context reference only for a live thread: %s",
  (kind) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(
        kind === "empty"
          ? "thread_"
          : kind === "malformed"
            ? "thread_/missing"
            : `thread_${bareId}`,
      );
      const shell = {
        ...liveThreadShell(bareId),
        deletedAt: kind === "deleted" ? DateTime.makeUnsafe("2026-10-05T00:00:00Z") : null,
      };
      const read = readThread(threadId).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, client),
        Effect.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(id === bareId && kind !== "unknown" ? shell : null),
            getProjectThreadRecords: (input) => {
              expect(input.threadId).toBe(bareId);
              return Effect.succeed(idleThreadProjection(shell));
            },
          }),
        ),
      );
      if (kind === "live") {
        expect((yield* read).projection.thread.id).toBe(bareId);
      } else {
        const error = yield* read.pipe(Effect.flip);
        expect(error.code).toBe("thread_not_found");
        expect(error.message).toBe("The thread was not found.");
      }
    }),
);
