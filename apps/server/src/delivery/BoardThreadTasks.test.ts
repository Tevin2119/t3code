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
import * as BoardTasks from "./BoardThreadTasks.ts";
import * as Delivery from "./DeliveryService.ts";
import { APP_FIX, SANDBOX_A, SANDBOX_B, compareWithPorts } from "./deploymentPort.fixture.ts";

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
  probe: DeliveryError = refusal(400, "Missing request ID", "invalid-field"),
  failFiledRecord = false,
  compare: unknown = null,
) {
  const cards = yield* Queue.unbounded<Card>();
  const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const calls: Array<Parameters<Act>[0]> = [];
  const reads: Array<string> = [];
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
          boardThreadConfiguration: Effect.sync(() => {
            reads.push("configuration");
            return "engine-test";
          }),
          read: ({ path }) =>
            Effect.sync(() => {
              reads.push(path);
              return { readAt: "2026-11-27T12:00:00Z", body: compare };
            }),
          boardThreadAct: (input) =>
            Effect.suspend((): ReturnType<Act> => {
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
        Layer.succeed(HostProcess.Environment, { [Delivery.BOARD_THREAD_KEY_VARIABLE]: key }),
      ),
    ),
  );
  return {
    cards,
    calls,
    reads,
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
          method: "POST" as const,
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

const portInput = {
  board: "work",
  from: "payoutlab-qa",
  to: "payoutlab-app",
  requestedBy: "Tevin",
  commits: [SANDBOX_B, SANDBOX_A],
};
const portOrigin = "deployment:environment-test/payoutlab-qa..payoutlab-app";
const portFiled: Act = () =>
  Effect.succeed({
    readAt: "2026-11-27T12:00:01Z",
    body: { created: true, task: { ...task, origin: portOrigin }, port: {} },
  });
const bodyOf = (call: Parameters<Act>[0]) => call.body as Record<string, unknown>;

it.effect("files a port for the page with the stamped origin and the engine's own subjects", () =>
  Effect.gen(function* () {
    const { calls, reads, layer } = yield* harness(portFiled, undefined, false, compareWithPorts);
    yield* Effect.gen(function* () {
      const service = yield* BoardTasks.BoardThreadTasks;
      const environmentId = EnvironmentId.make("environment-test");
      const filing = yield* service.filePort(environmentId, portInput);
      // The engine configuration is fixed before the reading the filing rests on, as for a thread.
      assert.deepStrictEqual(reads, [
        "configuration",
        "/api/deployments/compare?from=payoutlab-qa&to=payoutlab-app",
      ]);
      assert.strictEqual(filing.task.origin, portOrigin);
      yield* service.filePort(environmentId, { ...portInput, commits: [SANDBOX_A, SANDBOX_B] });
      assert.strictEqual(calls.length, 2);
      const [first, second] = calls.map(bodyOf);
      assert.strictEqual(calls[0]!.path, path);
      assert.strictEqual(calls[0]!.configuration, "engine-test");
      // The keyed actor is this environment; the person's name is attribution in the text only.
      assert.deepInclude(first, {
        origin: portOrigin,
        key,
        by: "environment-test",
        title: "Port to app: 2 sandbox commits",
      });
      assert.deepStrictEqual(first!.commits, [SANDBOX_A, SANDBOX_B]);
      assert.include(String(first!.body), "- Requested by: Tevin");
      assert.include(String(first!.body), `- ${SANDBOX_B} "#129 feat: sandbox payout"`);
      // The same port in any order is one request, so filing it twice replays the first.
      assert.match(String(first!.requestId), /^port-[a-f0-9]{64}$/);
      assert.strictEqual(second!.requestId, first!.requestId);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("refuses a commit the release line does not offer to port, before writing", () =>
  Effect.gen(function* () {
    const { calls, layer } = yield* harness(portFiled, undefined, false, compareWithPorts);
    yield* Effect.gen(function* () {
      const service = yield* BoardTasks.BoardThreadTasks;
      const environmentId = EnvironmentId.make("environment-test");
      for (const input of [
        { ...portInput, commits: [APP_FIX] },
        { ...portInput, board: "unsorted" },
        { ...portInput, from: "payoutlab-staging" },
      ]) {
        const error = yield* Effect.flip(service.filePort(environmentId, input));
        assert.strictEqual(error.code, "invalid_request");
      }
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("files anew under a new request ID once the earlier port's task was discarded", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const discardedOnce: Act = (input) =>
      attempts++ === 0 ? Effect.fail(refusal(410, "discarded", "gone")) : portFiled(input);
    const { calls, layer } = yield* harness(discardedOnce, undefined, false, compareWithPorts);
    yield* Effect.gen(function* () {
      const service = yield* BoardTasks.BoardThreadTasks;
      yield* service.filePort(EnvironmentId.make("environment-test"), portInput);
      const [first, retry] = calls.map((call) => String(bodyOf(call).requestId));
      assert.strictEqual(calls.length, 2);
      assert.notStrictEqual(retry, first);
      assert.match(retry!, /^port-[a-f0-9]{55}-[0-9a-f-]{36}$/);
    }).pipe(Effect.provide(layer));
  }),
);
