import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type DeliveryQaReceipt,
  type DeliverySeatHandoff,
  EnvironmentId,
  NodeId,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpTerminalDelegatedTaskStatus,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BOARD_THREAD_KEY_VARIABLE } from "./BoardTaskThreads.ts";
import { scratchEngine, scratchEngineHttp } from "./boardThreadEngine.testkit.ts";
import { boardTaskOf, boardTaskThreadMarker } from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";
import * as SeatHandoffs from "./SeatHandoffs.ts";

const ENVIRONMENT = EnvironmentId.make("local-test-environment");
const PARENT = ThreadId.make("thread:board-parent");
const QA = ThreadId.make("thread:qa");
const BUILDER = ThreadId.make("thread:builder");
const TASK_PATH = "/api/tasks/task-17";
const RUN = "run-24";
const ATTESTATION_PATH = `/api/runs/${RUN}/seat-attestations`;
const HANDOFF_PATH = `/api/runs/${RUN}/handoffs`;
const RECEIPT_PATH = `${TASK_PATH}/qa-receipts`;
const ACCEPTANCE = "The preview renders the report.";
const KEY = "scratch-key";
const INPUT = { acceptanceIndex: 0, verdict: "pass", evidence: ["report.png"] } as const;

const scopeFor = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: ENVIRONMENT,
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "test",
});

function harness(
  options: {
    readonly key?: boolean;
    readonly checklist?: string[];
    readonly seatThread?: { readonly environmentId: string; readonly threadId: string } | null;
    readonly boardThread?: { readonly environmentId: string; readonly threadId: string };
    readonly handoffResponse?: "lost" | "committed-lost" | "conflict" | "independence";
    readonly settleResponse?: "committed-lost";
    readonly receiptRefusal?: {
      readonly status: number;
      readonly code: string;
      readonly field?: string;
    };
  } = {},
) {
  const engine = scratchEngine();
  const task = boardTaskOf("board", "task-17")!;
  let acceptance = options.checklist ?? [ACCEPTANCE];
  let handoff: typeof DeliverySeatHandoff.Type | undefined;
  let handoffResponse = options.handoffResponse;
  let attestedThread: string = QA;
  let qaReceipts: ReadonlyArray<typeof DeliveryQaReceipt.Type> = [];
  let terminal: OrchestratorMcpTerminalDelegatedTaskStatus | null = null;
  const admissions = new Map<string, { childThreadId: ThreadId; taskId: NodeId }>();
  const launches: Array<{ namespace: string; input: OrchestratorMcpDelegateTaskInput }> = [];
  const cancels: Array<NodeId> = [];
  let settleLost = false;
  const statusReads: NodeId[] = [];
  const layer = SeatHandoffs.layer.pipe(
    Layer.provideMerge(DeliveryService.layer(deriveProviderInstanceConfigMap)),
    Layer.provide(
      scratchEngineHttp({
        ...engine,
        handle(method, path, body) {
          if (method === "GET" && path === TASK_PATH) {
            engine.requests.push({ method, path, body });
            return {
              status: 200,
              body: {
                title: "Verify report preview",
                body: "A report should appear in the preview pane.",
                boardThread: options.boardThread ?? {
                  environmentId: ENVIRONMENT,
                  threadId: PARENT,
                },
                acceptance,
                handoffs: handoff ? [handoff] : [],
                qaReceipts,
                council: {
                  run: RUN,
                  candidate: "a".repeat(40),
                  base: "b".repeat(40),
                  seats: [
                    { seat: "unavailable", harness: "dsh", requestedModel: "unavailable-model" },
                    {
                      seat: "validation",
                      threadId: options.seatThread ? "old-thread-field" : attestedThread,
                      seatThread: options.seatThread,
                      actualModel: "qa-model",
                      harness: "dsh",
                      requestedModel: "original-model",
                      currentModel: { model: "picked-model", harness: "codex", source: "picked" },
                    },
                    { seat: "builder", threadId: BUILDER, actualModel: "build-model" },
                    { seat: "backup", harness: "codex", requestedModel: "backup-model" },
                  ],
                },
                roster: [
                  { seat: "unavailable", inGate: true },
                  { seat: "validation", inGate: true },
                  { seat: "builder", inGate: false, stages: ["build"] },
                  { seat: "backup", inGate: true },
                ],
              },
            };
          }
          if (method === "POST" && path === ATTESTATION_PATH) {
            engine.requests.push({ method, path, body });
            const input = body as {
              seat: string;
              threadId: string;
              model: string;
              harness?: string;
            };
            attestedThread = input.threadId;
            return {
              status: 200,
              body: {
                attestation: {
                  run: RUN,
                  seat: input.seat,
                  threadId: input.threadId,
                  environmentId: ENVIRONMENT,
                  model: input.model,
                  harness: input.harness,
                },
              },
            };
          }
          if (method === "POST" && path === HANDOFF_PATH) {
            engine.requests.push({ method, path, body });
            if (handoffResponse === "lost") {
              handoffResponse = undefined;
              return { status: 503, body: { error: "Engine unavailable." } };
            }
            if (handoffResponse === "independence") {
              handoffResponse = undefined;
              return { status: 409, body: { code: "independence", error: "Engine refusal." } };
            }
            handoff = {
              id: (handoff?.id ?? 0) + 1,
              run: RUN,
              stage: "qa",
              seat: (body as { seat: string }).seat,
              seatThread: { environmentId: ENVIRONMENT, threadId: attestedThread },
              state: "handed",
            };
            if (handoffResponse === "committed-lost") {
              handoffResponse = undefined;
              return { status: 503, body: { error: "Engine unavailable." } };
            }
            if (handoffResponse === "conflict") {
              handoffResponse = undefined;
              return {
                status: 409,
                body: { code: "conflict", error: "Already handed.", current: handoff },
              };
            }
            return { status: 200, body: { run: RUN, handoff } };
          }
          if (method === "POST" && handoff && path.startsWith(`${HANDOFF_PATH}/qa/`)) {
            engine.requests.push({ method, path, body });
            const delivered = path.endsWith("/delivered");
            handoff = {
              ...handoff,
              id: handoff.id! + 1,
              state: delivered ? "delivered" : "fallen-back",
              reason: delivered ? null : (body as { reason: string }).reason,
            };
            if (options.settleResponse === "committed-lost" && !settleLost) {
              settleLost = true;
              return { status: 503, body: { error: "Engine unavailable." } };
            }
            return { status: 200, body: { run: RUN, handoff } };
          }
          if (method === "POST" && path === RECEIPT_PATH) {
            engine.requests.push({ method, path, body });
            if (options.receiptRefusal) {
              const { status, ...details } = options.receiptRefusal;
              acceptance = ["The preview works offline.", "The report can be exported."];
              return { status, body: { error: "Unrelated engine prose.", ...details } };
            }
            return {
              status: 200,
              body: { qaReceipt: { id: 21, modelSource: "attested", independenceChecked: true } },
            };
          }
          return engine.handle(method, path, body);
        },
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(ENVIRONMENT),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadManagementService.ThreadManagementService, {
        getThreadShell: (threadId: ThreadId) => {
          const child = [...admissions.values()].find(
            ({ childThreadId }) => childThreadId === threadId,
          );
          return Effect.succeed(
            threadId === PARENT
              ? { lineage: { engineIntake: boardTaskThreadMarker(task) } }
              : {
                  lineage: { parentThreadId: PARENT },
                  forkedFrom: child ? { type: "node", nodeId: child.taskId } : null,
                },
          );
        },
      } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(OrchestratorMcpService.OrchestratorMcpService, {
        capabilities: () =>
          Effect.succeed({
            providers: [
              { driverKind: "deepseek", providerInstanceId: "deepseek", canRunChildTask: false },
              { driverKind: "codex", providerInstanceId: "other-codex", canRunChildTask: true },
              { driverKind: "codex", providerInstanceId: "codex", canRunChildTask: true },
            ],
          }),
        delegateTask: (scope: McpInvocationScope, input: OrchestratorMcpDelegateTaskInput) => {
          launches.push({ namespace: scope.requestNamespace, input });
          const request = `${scope.requestNamespace}:${input.clientRequestId}`;
          const existing = admissions.get(request);
          const child = existing ?? {
            taskId: NodeId.make(`node:qa:${admissions.size}`),
            childThreadId: ThreadId.make(`thread:qa:${admissions.size}`),
          };
          admissions.set(request, child);
          return Effect.succeed({
            ...child,
            providerInstanceId: input.target?.providerInstanceId,
            model: "launched-model",
          });
        },
        cancelTask: (_scope: McpInvocationScope, input: { readonly taskId: NodeId }) => {
          cancels.push(input.taskId);
          return Effect.succeed({});
        },
        taskStatus: (_scope: McpInvocationScope, taskId: NodeId) => {
          statusReads.push(taskId);
          return Effect.succeed({
            childThreadId: [...admissions.values()].find((entry) => entry.taskId === taskId)
              ?.childThreadId,
            workState: terminal === null ? "working" : "result_available",
            hasPendingChildRuns: false,
            latestTerminalStatus: terminal,
          });
        },
      } as unknown as OrchestratorMcpService.OrchestratorMcpService["Service"]),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        delivery: { enabled: true, engineUrl: "http://127.0.0.1:4320" },
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "seat-handoffs-" })),
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(
      Layer.succeed(
        HostProcess.Environment,
        options.key === false
          ? {}
          : {
              [BOARD_THREAD_KEY_VARIABLE]: KEY,
            },
      ),
    ),
  );
  return {
    layer,
    requests: engine.requests,
    admissions,
    launches,
    statusReads,
    cancels,
    finish(status: OrchestratorMcpTerminalDelegatedTaskStatus, receipts: typeof qaReceipts = []) {
      terminal = status;
      qaReceipts = receipts;
    },
  };
}

it.effect("attests a seat with the launched model, harness and server identity", () => {
  const { layer, requests } = harness();
  return Effect.gen(function* () {
    const handoffs = yield* SeatHandoffs.SeatHandoffs;
    yield* handoffs.attestSeat(RUN, "validation", QA, "qa-model", "codex");
    assert.deepEqual(requests, [
      {
        method: "POST",
        path: ATTESTATION_PATH,
        body: {
          seat: "validation",
          environmentId: ENVIRONMENT,
          threadId: QA,
          model: "qa-model",
          harness: "codex",
          setBy: ENVIRONMENT,
          key: KEY,
        },
      },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  { label: "infers an omitted seat thread", seatThread: undefined },
  {
    label: "uses the engine's seat thread in preference to the legacy thread id",
    seatThread: { environmentId: ENVIRONMENT, threadId: QA },
  },
])("files a receipt and $label", ({ seatThread }) => {
  const { layer, requests } = harness(seatThread ? { seatThread } : {});
  return Effect.gen(function* () {
    const handoffs = yield* SeatHandoffs.SeatHandoffs;
    const input = {
      ...INPUT,
      run: "other-run",
      seat: "other-seat",
      seatThread: { environmentId: "other-env", threadId: "other-thread" },
      acceptance: { index: 9, hash: "forged" },
    };
    const { qaReceipt } = yield* handoffs.fileQaReceipt(scopeFor(QA), input);
    assert.deepEqual(requests.at(-1), {
      method: "POST",
      path: RECEIPT_PATH,
      body: {
        run: RUN,
        seat: "validation",
        seatThread: { environmentId: ENVIRONMENT, threadId: QA },
        acceptance: { index: 0, hash: "87b61f888e1f0da4" },
        verdict: "pass",
        evidence: ["report.png"],
        filedBy: ENVIRONMENT,
        key: KEY,
      },
    });
    assert.deepEqual(qaReceipt, { id: 21, modelSource: "attested", independenceChecked: true });
  }).pipe(Effect.provide(layer));
});

it.effect("rejects a child caller and a lead whose task is held by another thread", () => {
  const { layer, requests, launches } = harness({
    boardThread: { environmentId: ENVIRONMENT, threadId: "different-lead" },
  });
  return Effect.gen(function* () {
    const service = yield* SeatHandoffs.SeatHandoffs;
    for (const caller of [QA, PARENT]) {
      const failure = yield* Effect.flip(service.handQa(scopeFor(caller), {}));
      assert.equal(failure.code, "invalid_request");
      assert.match(failure.message, /lead thread/);
    }
    assert.isEmpty(launches);
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("hands QA to the first launchable gate seat and attests the model T3 launched", () => {
  const { layer, launches, requests } = harness();
  return Effect.gen(function* () {
    const service = yield* SeatHandoffs.SeatHandoffs;
    const result = yield* service.handQa(scopeFor(PARENT), {});
    assert.equal(result.state, "working");
    assert.match(result.next ?? "", /end your turn.*do not poll/);
    assert.equal(result.handoff.seat, "validation");
    assert.lengthOf(launches, 1);
    const launch = launches[0]!.input;
    assert.equal(launch.isolation, "worktree");
    assert.equal(launch.mode, "async");
    assert.deepEqual(launch.target, {
      providerInstanceId: ProviderInstanceId.make("codex"),
      model: "picked-model",
      options: [],
    });
    for (const text of [
      "Verify report preview",
      "A report should appear in the preview pane.",
      `0. ${ACCEPTANCE}`,
      "a".repeat(40),
      "b".repeat(40),
      "exactly one delivery_qa_receipt",
      "Do not edit code.",
    ])
      assert.include(launch.task, text);
    assert.deepEqual(
      requests.filter(({ method }) => method === "POST"),
      [
        {
          method: "POST",
          path: ATTESTATION_PATH,
          body: {
            seat: "validation",
            environmentId: ENVIRONMENT,
            threadId: "thread:qa:0",
            model: "launched-model",
            harness: "codex",
            setBy: ENVIRONMENT,
            key: KEY,
          },
        },
        {
          method: "POST",
          path: HANDOFF_PATH,
          body: { stage: "qa", seat: "validation", setBy: ENVIRONMENT, key: KEY },
        },
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "recovers the same filing across sessions and launches a new child after settlement",
  () => {
    const { layer, launches, admissions, statusReads, finish } = harness({
      handoffResponse: "lost",
    });
    const lead = scopeFor(PARENT);
    return Effect.gen(function* () {
      const service = yield* SeatHandoffs.SeatHandoffs;
      yield* Effect.flip(service.handQa(lead, {}));
      const newSession = { ...lead, requestNamespace: "another-session" };
      const recovered = yield* service.handQa(newSession, {});
      assert.equal(recovered.state, "working");
      assert.equal(admissions.size, 1);
      assert.deepEqual(
        launches.map(({ namespace }) => namespace),
        [`delivery-handoff:${RUN}:qa:0`, `delivery-handoff:${RUN}:qa:0`],
      );
      assert.deepEqual(yield* service.handQa(newSession, {}), recovered);
      assert.deepEqual(statusReads, ["node:qa:0"]);
      assert.lengthOf(launches, 2);

      finish("interrupted");
      assert.equal((yield* service.handQa(newSession, {})).handoff.reason, "seat-failed");
      // A settled hand-off is returned on retry; only `again` files QA anew.
      assert.equal((yield* service.handQa(newSession, {})).handoff.reason, "seat-failed");
      assert.equal(admissions.size, 1);
      const refiled = yield* service.handQa(newSession, { again: true });
      assert.equal(refiled.handoff.seatThread?.threadId, "thread:qa:1");
      assert.equal(admissions.size, 2);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("keeps a seat whose hand-off the engine took when the answer is lost", () => {
  const { layer, cancels, launches } = harness({ handoffResponse: "committed-lost" });
  return Effect.gen(function* () {
    const service = yield* SeatHandoffs.SeatHandoffs;
    const result = yield* service.handQa(scopeFor(PARENT), {});
    assert.equal(result.state, "working");
    assert.deepEqual(cancels, []);
    assert.lengthOf(launches, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("returns a settled hand-off whose answer was lost instead of filing QA again", () => {
  const { layer, finish, launches } = harness({ settleResponse: "committed-lost" });
  return Effect.gen(function* () {
    const service = yield* SeatHandoffs.SeatHandoffs;
    const lead = scopeFor(PARENT);
    yield* service.handQa(lead, {});
    finish("failed", []);
    yield* Effect.flip(service.handQa(lead, {}));
    const retried = yield* service.handQa(lead, {});
    assert.equal(retried.state, "fallen-back");
    assert.equal(retried.handoff.reason, "seat-failed");
    assert.lengthOf(launches, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("recovers the current record carried by an engine conflict", () => {
  const { layer, statusReads, launches } = harness({ handoffResponse: "conflict" });
  return Effect.gen(function* () {
    const service = yield* SeatHandoffs.SeatHandoffs;
    const result = yield* service.handQa(scopeFor(PARENT), { seat: "backup" });
    assert.equal(result.state, "working");
    assert.equal(result.handoff.seat, "backup");
    assert.deepEqual(statusReads, ["node:qa:0"]);
    assert.equal(launches[0]?.input.target?.model, "backup-model");
  }).pipe(Effect.provide(layer));
});

it.effect("maps the engine's independence refusal and names the other gate seats", () => {
  const { layer, cancels } = harness({ handoffResponse: "independence" });
  return Effect.gen(function* () {
    const service = yield* SeatHandoffs.SeatHandoffs;
    const failure = yield* Effect.flip(service.handQa(scopeFor(PARENT), {}));
    assert.equal(failure.code, "invalid_request");
    // The refused seat is stopped before it can file receipts.
    assert.deepEqual(cancels, ["node:qa:0"]);
    assert.equal(
      failure.message,
      "That QA seat shares the builder's model family; pick another seat (seat: backup)",
    );
    assert.equal(
      (yield* service.handQa(scopeFor(PARENT), { seat: "backup" })).handoff.seat,
      "backup",
    );
  }).pipe(Effect.provide(layer));
});

const currentReceipt = {
  run: RUN,
  seat: "validation",
  acceptance: { index: 0 },
  verdict: "fail",
} as const;
const secondReceipt = { ...currentReceipt, acceptance: { index: 1 }, verdict: "blocked" } as const;
it.effect.each([
  { terminal: "completed", receipts: [currentReceipt, secondReceipt], reason: null },
  {
    terminal: "completed",
    receipts: [
      currentReceipt,
      { ...secondReceipt, run: "old-run" },
      { ...secondReceipt, seat: "backup" },
    ],
    reason: "no-receipts",
  },
  { terminal: "failed", receipts: [currentReceipt], reason: "seat-failed" },
  { terminal: "cancelled", receipts: [], reason: "seat-failed" },
] as const)(
  "settles a $terminal QA child with reason $reason",
  ({ terminal, receipts, reason }) => {
    const { layer, finish, requests } = harness({
      checklist: [ACCEPTANCE, "The report can be exported."],
    });
    return Effect.gen(function* () {
      const service = yield* SeatHandoffs.SeatHandoffs;
      const lead = scopeFor(PARENT);
      yield* service.handQa(lead, {});
      finish(terminal, receipts);
      const result = yield* service.handQa(lead, {});
      assert.equal(result.state, reason ? "fallen-back" : "delivered");
      assert.equal(result.handoff.reason, reason);
      assert.deepEqual(requests.at(-1), {
        method: "POST",
        path: `${HANDOFF_PATH}/qa/${reason ? "fallback" : "delivered"}`,
        body: { ...(reason ? { reason } : {}), setBy: ENVIRONMENT, key: KEY },
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("refuses callers without an attested QA seat on the current run", () => {
  const { layer, requests } = harness();
  return Effect.gen(function* () {
    const handoffs = yield* SeatHandoffs.SeatHandoffs;
    for (const threadId of [PARENT, ThreadId.make("thread:unattested"), BUILDER]) {
      const failure = yield* Effect.flip(handoffs.fileQaReceipt(scopeFor(threadId), INPUT));
      assert.equal(failure.code, "invalid_request");
      assert.match(failure.message, /attested/);
    }
    assert.isFalse(requests.some((request) => request.method === "POST"));
  }).pipe(Effect.provide(layer));
});

it.effect("maps an independence refusal by code and tells the QA seat to stop", () => {
  const { layer, requests } = harness({
    receiptRefusal: { status: 409, code: "independence" },
  });
  return Effect.gen(function* () {
    const handoffs = yield* SeatHandoffs.SeatHandoffs;
    const failure = yield* Effect.flip(handoffs.fileQaReceipt(scopeFor(QA), INPUT));
    assert.match(failure.message, /builder's model.*Do not retry.*different model/);
    assert.lengthOf(
      requests.filter((request) => request.method === "POST"),
      1,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("reads and returns the updated numbered checklist after hash drift", () => {
  const { layer, requests } = harness({
    receiptRefusal: { status: 400, code: "invalid-field", field: "acceptance.hash" },
  });
  return Effect.gen(function* () {
    const handoffs = yield* SeatHandoffs.SeatHandoffs;
    const failure = yield* Effect.flip(handoffs.fileQaReceipt(scopeFor(QA), INPUT));
    assert.include(
      failure.message,
      "1. The preview works offline.\n2. The report can be exported.",
    );
    assert.deepEqual(
      requests.map(({ method, path }) => [method, path]),
      [
        ["GET", TASK_PATH],
        ["POST", RECEIPT_PATH],
        ["GET", TASK_PATH],
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("refuses both operations without a host key before contacting the engine", () => {
  const { layer, requests } = harness({ key: false });
  return Effect.gen(function* () {
    const handoffs = yield* SeatHandoffs.SeatHandoffs;
    const receipt = yield* Effect.flip(handoffs.fileQaReceipt(scopeFor(QA), INPUT));
    const attestation = yield* Effect.flip(handoffs.attestSeat(RUN, "validation", QA, "qa-model"));
    assert.match(receipt.message, /no board approval key/);
    assert.match(attestation.message, /no board approval key/);
    assert.isEmpty(requests);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps seat attestations and receipts out of the generic delivery relay", () => {
  const { layer, requests } = harness();
  return Effect.gen(function* () {
    const delivery = yield* DeliveryService.DeliveryService;
    for (const path of [
      ATTESTATION_PATH,
      RECEIPT_PATH,
      HANDOFF_PATH,
      `${HANDOFF_PATH}/qa/delivered`,
      `${HANDOFF_PATH}/qa/fallback`,
    ]) {
      const error = yield* Effect.flip(delivery.act({ path, body: { key: KEY } }));
      assert.equal(error.reason, "refused");
    }
    assert.isEmpty(requests);
  }).pipe(Effect.provide(layer));
});
