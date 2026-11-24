import { assert, it } from "@effect/vitest";
import {
  DeliveryError,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
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
const path = "/api/boards/work/tasks";
const task = {
  id: "task-17",
  number: 17,
  board: "work",
  origin,
  team: "development",
  state: "draft",
};
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
  probe = refusal(400, "Missing request ID", "invalid-field"),
  failFiledRecord = false,
) {
  const cards = yield* Queue.unbounded<Card>();
  const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const calls: Array<Parameters<Act>[0]> = [];
  const now = DateTime.makeUnsafe("2026-11-24T00:00:00Z");
  const run = {
    id: RunId.make("run:test"),
    threadId: scope.thread.threadId,
    ordinal: 1,
    status: "running",
    rootNodeId: NodeId.make("node:test"),
    providerInstanceId: scope.thread.providerInstanceId,
    modelSelection: { instanceId: scope.thread.providerInstanceId, model: "test" },
    providerThreadId: null,
    userMessageId: MessageId.make("message:test"),
    activeAttemptId: null,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  } satisfies OrchestrationV2Run;
  const activeRun = yield* Ref.make<OrchestrationV2Run>(run);
  const layer = BoardTasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Delivery.DeliveryService)({
          boardThreadConfiguration: Effect.succeed("engine-test"),
          boardThreadAct: (input) =>
            Effect.suspend(() => {
              calls.push(input);
              const body = input.body;
              return typeof body === "object" && body !== null && !("requestId" in body)
                ? Effect.fail(probe)
                : file(input);
            }),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadRecords: () =>
            Ref.get(activeRun).pipe(Effect.map((run) => ({ runs: [run] }))) as never,
          dispatch: (command) =>
            command.type !== "board_task_request.record"
              ? Effect.die("Unexpected dispatch")
              : failFiledRecord && command.resolution.status === "filed"
                ? Effect.fail(
                    new Orchestrator.OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause: "Record unavailable",
                    }),
                  )
                : Queue.offer(cards, command).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          streamStoredEventsFrom: () => Stream.fromQueue(events),
        }),
        SecureRandom.layerWebCrypto,
        Layer.succeed(HostProcess.Environment, { [BOARD_THREAD_KEY_VARIABLE]: key }),
      ),
    ),
  );
  return {
    cards,
    calls,
    layer,
    activeRun,
    endRun: Queue.offer(events, {
      sequence: 1,
      commandId: null,
      event: {
        id: EventId.make("event:run-ended"),
        type: "run.updated",
        threadId: run.threadId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      },
    }),
  };
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

it.effect.each([
  {
    cause: "an older engine",
    envelope: undefined,
    code: "unsupported",
    message: "This engine does not take thread filings yet",
  },
  {
    cause: "a missing board",
    envelope: "not-found",
    code: "invalid_request",
    message: "no such board",
  },
])("rejects $cause before showing a confirmation card", ({ envelope, code, message }) =>
  Effect.gen(function* () {
    const { calls, cards, layer } = yield* harness(undefined, refusal(404, "not found", envelope));
    yield* Effect.gen(function* () {
      const service = yield* BoardTasks.BoardThreadTasks;
      const error = yield* Effect.flip(service.request(scope, draft));
      assert.strictEqual(error.code, code);
      assert.strictEqual(error.message, message);
      assert.deepStrictEqual(yield* Queue.size(cards), 0);
      assert.deepStrictEqual(
        calls.map(({ path, body }) => ({ path, body })),
        [{ path, body: { origin, key } }],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each([
  "decline",
  "abort",
  "timeout",
  "terminal run update",
  "changed root before File",
] as const)("closes a pending filing on %s without writing to the engine", (action) =>
  Effect.gen(function* () {
    const { calls, cards, layer, activeRun, endRun } = yield* harness();
    yield* Effect.gen(function* () {
      const service = yield* BoardTasks.BoardThreadTasks;
      const call = yield* service.request(scope, draft).pipe(Effect.forkChild);
      const { threadId, turnItemId } = yield* Queue.take(cards);
      if (action === "decline") {
        yield* service.answer({ threadId, turnItemId, answer: "decline" });
      } else if (action === "abort") {
        yield* Fiber.interrupt(call);
      } else if (action === "timeout") {
        yield* TestClock.adjust("10 minutes");
      } else if (action === "terminal run update") {
        yield* endRun;
      } else {
        yield* Ref.update(activeRun, (run) => ({ ...run, rootNodeId: NodeId.make("node:next") }));
        yield* service.answer({ threadId, turnItemId, answer: "file" });
      }
      const { resolution } = yield* Queue.take(cards);
      assert.strictEqual(resolution.status, action === "decline" ? "declined" : "cancelled");
      if (action !== "abort") assert.deepStrictEqual(yield* Fiber.join(call), resolution);
      assert.deepStrictEqual(
        calls.map(({ path, body }) => ({ path, body })),
        [{ path, body: { origin, key } }],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "files exactly the approved draft with the scoped origin and replays a lost receipt",
  () =>
    Effect.gen(function* () {
      let writes = 0;
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
        const digest = yield* Effect.promise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(turnItemId)),
        );
        const expected = {
          method: "POST",
          path,
          configuration: "engine-test",
          body: {
            requestId: Hex.encode(new Uint8Array(digest)),
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

it.effect("returns the filed outcome when recording the card fails", () =>
  Effect.gen(function* () {
    const receipt = { created: true, task };
    const { cards, calls, layer } = yield* harness(
      () => Effect.succeed({ readAt: "now", body: receipt }),
      undefined,
      true,
    );
    yield* Effect.gen(function* () {
      const service = yield* BoardTasks.BoardThreadTasks;
      const call = yield* service.request(scope, draft).pipe(Effect.forkChild);
      const { threadId, turnItemId } = yield* Queue.take(cards);
      yield* service.answer({ threadId, turnItemId, answer: "file" });
      assert.deepStrictEqual(yield* Fiber.join(call), { status: "filed", filing: receipt });
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.provide(layer));
  }),
);
