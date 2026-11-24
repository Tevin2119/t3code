import { createHash } from "node:crypto";

import { assert, it } from "@effect/vitest";
import {
  DeliveryError,
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { BOARD_THREAD_KEY_VARIABLE } from "./BoardTaskThreads.ts";
import * as BoardTasks from "./BoardThreadTasks.ts";
import * as Delivery from "./DeliveryService.ts";

const scope = {
  environmentId: EnvironmentId.make("environment-test"),
  thread: {
    threadId: ThreadId.make("thread:test"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "session-test",
  },
  client: undefined,
  issuedAt: 0,
  requestNamespace: "filing-test",
  capabilities: new Set(["orchestration"] as const),
} satisfies McpInvocationScope;
const origin = "thread:environment-test/thread:test";
const key = "test-approval-key";
const draft = {
  board: "work",
  title: " Draft task ",
  body: "Body with **formatting**\n",
  context: " Quoted context ",
};
type Card = Extract<OrchestrationV2ServerCommand, { readonly type: "board_task_request.record" }>;
type Act = Delivery.DeliveryService["Service"]["boardThreadAct"];

const refusal = (status: number, detail: string, code?: string) =>
  new DeliveryError({
    reason: "refused",
    status,
    detail,
    body: { error: detail, ...(code === undefined ? {} : { code }) },
  });

const harness = Effect.fn("BoardThreadTasks.testHarness")(function* (
  file: Act = () => Effect.die("Unexpected filing"),
  probe = refusal(400, "Reserved board", "invalid-field"),
) {
  const cards = yield* Queue.unbounded<Card>();
  const calls: Array<Parameters<Act>[0]> = [];
  const run = {
    id: RunId.make("run:test"),
    ordinal: 1,
    status: "running",
    rootNodeId: NodeId.make("node:test"),
    providerInstanceId: scope.thread.providerInstanceId,
  } satisfies Partial<OrchestrationV2Run>;
  const layer = BoardTasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Delivery.DeliveryService)({
          boardThreadConfiguration: Effect.succeed("engine-test"),
          boardThreadAct: (input) =>
            Effect.suspend(() => {
              calls.push(input);
              return input.path === "/api/boards/all/tasks" ? Effect.fail(probe) : file(input);
            }),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed({ runs: [run] }) as never,
          dispatch: (command) =>
            command.type === "board_task_request.record"
              ? Queue.offer(cards, command).pipe(Effect.as({ sequence: 1, storedEvents: [] }))
              : Effect.die("Unexpected dispatch"),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          streamStoredEventsFrom: () => Stream.never,
        }),
        Layer.succeed(HostProcess.Environment, { [BOARD_THREAD_KEY_VARIABLE]: key }),
      ),
    ),
  );
  return { cards, calls, layer };
});

it.effect("refuses every reserved board before calling the engine", () =>
  Effect.gen(function* () {
    const { calls, layer } = yield* harness();
    yield* Effect.gen(function* () {
      const service = yield* BoardTasks.BoardThreadTasks;
      for (const board of ["unsorted", "all", "pilot", "qualification"]) {
        const error = yield* Effect.flip(service.request(scope, { ...draft, board }));
        assert.strictEqual(error.code, "invalid_request");
      }
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("rejects an older engine before showing a confirmation card", () =>
  Effect.gen(function* () {
    const { calls, cards, layer } = yield* harness(undefined, refusal(404, "not found"));
    yield* Effect.gen(function* () {
      const service = yield* BoardTasks.BoardThreadTasks;
      const error = yield* Effect.flip(service.request(scope, draft));
      assert.strictEqual(error.code, "unsupported");
      assert.deepStrictEqual(yield* Queue.size(cards), 0);
      assert.deepStrictEqual(
        calls.map(({ path, body }) => ({ path, body })),
        [{ path: "/api/boards/all/tasks", body: { origin, key } }],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["decline", "abort", "timeout"] as const)(
  "closes a pending filing on %s without writing to the engine",
  (action) =>
    Effect.gen(function* () {
      const { calls, cards, layer } = yield* harness();
      yield* Effect.gen(function* () {
        const service = yield* BoardTasks.BoardThreadTasks;
        const call = yield* service.request(scope, draft).pipe(Effect.forkChild);
        const { threadId, turnItemId } = yield* Queue.take(cards);
        if (action === "decline") {
          yield* service.answer({ threadId, turnItemId, answer: "decline" });
        } else if (action === "abort") {
          yield* Fiber.interrupt(call);
        } else {
          yield* TestClock.adjust("10 minutes");
        }
        const { resolution } = yield* Queue.take(cards);
        assert.strictEqual(resolution.status, action === "decline" ? "declined" : "cancelled");
        if (action !== "abort") assert.deepStrictEqual(yield* Fiber.join(call), resolution);
        assert.deepStrictEqual(
          calls.map(({ path }) => path),
          ["/api/boards/all/tasks"],
        );
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "files exactly the approved draft with the scoped origin and replays a lost receipt",
  () =>
    Effect.gen(function* () {
      let writes = 0;
      const task = {
        id: "task-17",
        number: 17,
        board: "work",
        origin,
        team: "development",
        state: "draft",
      };
      const { calls, cards, layer } = yield* harness(() =>
        Effect.suspend(() => {
          writes++;
          return writes === 1
            ? Effect.fail(new DeliveryError({ reason: "unreachable", detail: "Lost receipt" }))
            : Effect.succeed({ readAt: "now", body: { created: false, task } });
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* BoardTasks.BoardThreadTasks;
        const spoofed = { ...draft, origin: "thread:foreign/someone-else" };
        const call = yield* service.request(scope, spoofed).pipe(Effect.forkChild);
        const card = yield* Queue.take(cards);
        assert.strictEqual(card.resolution.status, "pending");
        assert.deepStrictEqual(card.draft, draft);
        assert.strictEqual(writes, 0);
        const { threadId, turnItemId } = card;
        const wrongThread = yield* Effect.flip(
          service.answer({
            threadId: ThreadId.make("thread:fork"),
            turnItemId,
            answer: "file",
          }),
        );
        assert.strictEqual(wrongThread.code, "invalid_request");
        yield* service.answer({ threadId, turnItemId, answer: "file" });
        assert.deepStrictEqual(yield* Fiber.join(call), {
          status: "filed",
          filing: { created: false, task },
        });
        const expected = {
          method: "POST",
          path: "/api/boards/work/tasks",
          configuration: "engine-test",
          body: {
            requestId: createHash("sha256").update(turnItemId).digest("hex"),
            title: card.draft.title,
            body: card.draft.body,
            context: card.draft.context,
            origin,
            key,
          },
        };
        assert.deepStrictEqual(calls.slice(1), [expected, expected]);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each([
  { status: 409, code: "conflict", message: "This request already filed different fields." },
  { status: 410, code: "gone", message: "The filed task was discarded." },
  { status: 404, code: "not-found", message: "No such custom board." },
  { status: 403, code: "refused", message: "The approval key is wrong or missing." },
])("records the refusal message for HTTP $status ($code)", ({ status, code, message }) =>
  Effect.gen(function* () {
    const { cards, calls, layer } = yield* harness(() =>
      Effect.fail(refusal(status, message, code)),
    );
    yield* Effect.gen(function* () {
      const service = yield* BoardTasks.BoardThreadTasks;
      const call = yield* service.request(scope, draft).pipe(Effect.forkChild);
      const { threadId, turnItemId } = yield* Queue.take(cards);
      yield* service.answer({ threadId, turnItemId, answer: "file" });
      const { resolution } = yield* Queue.take(cards);
      assert.deepStrictEqual(resolution, { status: "failed", message });
      assert.deepStrictEqual(yield* Fiber.join(call), resolution);
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.provide(layer));
  }),
);
