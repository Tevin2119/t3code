import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
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
    readonly receiptRefusal?: {
      readonly status: number;
      readonly code: string;
      readonly field?: string;
    };
  } = {},
) {
  const engine = scratchEngine();
  const task = boardTaskOf("board", "task-17")!;
  let acceptance = [ACCEPTANCE];
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
                acceptance,
                council: {
                  run: RUN,
                  seats: [
                    { seat: "validation", threadId: QA, actualModel: "qa-model" },
                    { seat: "builder", threadId: BUILDER, actualModel: "build-model" },
                  ],
                },
                roster: [
                  { seat: "validation", inGate: true },
                  { seat: "builder", inGate: false, stages: ["build"] },
                ],
              },
            };
          }
          if (method === "POST" && path === ATTESTATION_PATH) {
            engine.requests.push({ method, path, body });
            return {
              status: 200,
              body: {
                attestation: {
                  run: RUN,
                  seat: "validation",
                  threadId: QA,
                  environmentId: ENVIRONMENT,
                  model: "qa-model",
                  harness: "codex",
                },
              },
            };
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
        getThreadShell: (threadId: ThreadId) =>
          Effect.succeed(
            threadId === PARENT
              ? { lineage: { engineIntake: boardTaskThreadMarker(task) } }
              : { lineage: { parentThreadId: PARENT } },
          ),
      } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
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
  return { layer, requests: engine.requests };
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

it.effect("files a receipt from the current attested seat and hashes the acceptance text", () => {
  const { layer, requests } = harness();
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

it.effect("refuses callers without an attested QA seat on the current run", () => {
  const { layer, requests } = harness();
  return Effect.gen(function* () {
    const handoffs = yield* SeatHandoffs.SeatHandoffs;
    for (const threadId of [PARENT, ThreadId.make("thread:unattested"), BUILDER]) {
      const failure = yield* Effect.flip(handoffs.fileQaReceipt(scopeFor(threadId), INPUT));
      assert.equal(failure.code, "invalid_request");
      assert.match(failure.message, /attested QA seat/);
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
    for (const path of [ATTESTATION_PATH, RECEIPT_PATH]) {
      const error = yield* Effect.flip(delivery.act({ path, body: { key: KEY } }));
      assert.equal(error.reason, "refused");
    }
    assert.isEmpty(requests);
  }).pipe(Effect.provide(layer));
});
