import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { withNativeTurnReceipt } from "./ForkAcpAdapter.ts";

const start = () =>
  Effect.succeed({
    sessionId: "native-session",
    initializeResult: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
    sessionSetupResult: { sessionId: "native-session" },
    modelConfigId: undefined,
  });
const prompt = { prompt: [{ type: "text" as const, text: "Do the requested work." }] };

it.effect("a successful ACP stop reason cannot hide a failed native turn receipt", () =>
  Effect.gen(function* () {
    const native = yield* AcpSessionRuntime.AcpSessionRuntime;
    const runtime = withNativeTurnReceipt(native, {
      turnEnd: () => Effect.succeed({ endedWell: false, why: "The inference call failed." }),
    });
    yield* runtime.start();
    const result = yield* runtime.prompt(prompt).pipe(Effect.result);
    if (result._tag !== "Failure")
      return assert.fail("The failed native turn was marked complete.");
    assert.strictEqual(result.failure._tag, "AcpTransportError");
  }).pipe(
    Effect.provide(
      Layer.mock(AcpSessionRuntime.AcpSessionRuntime)({
        processContainment: "process-group",
        start,
        prompt: () => Effect.succeed({ stopReason: "end_turn" as const }),
      }),
    ),
  ),
);

it.effect(
  "native receipt checks use the pre-prompt turn count and preserve verified completion",
  () =>
    Effect.gen(function* () {
      const native = yield* AcpSessionRuntime.AcpSessionRuntime;
      const runtime = withNativeTurnReceipt(native, {
        countTurnEnds: () => Effect.succeed(4),
        turnEnd: (sessionId, before) => {
          assert.strictEqual(sessionId, "native-session");
          assert.strictEqual(before, 4);
          return Effect.succeed({ endedWell: true, why: undefined });
        },
      });
      yield* runtime.start();
      assert.deepEqual(yield* runtime.prompt(prompt), { stopReason: "end_turn" });
    }).pipe(
      Effect.provide(
        Layer.mock(AcpSessionRuntime.AcpSessionRuntime)({
          processContainment: "process-group",
          start,
          prompt: () => Effect.succeed({ stopReason: "end_turn" as const }),
        }),
      ),
    ),
);

it.effect("an interrupted native prompt stays cancelled without consulting a success receipt", () =>
  Effect.gen(function* () {
    const native = yield* AcpSessionRuntime.AcpSessionRuntime;
    const runtime = withNativeTurnReceipt(native, {
      turnEnd: () => Effect.die("Cancelled prompts must not be checked for successful completion."),
    });
    yield* runtime.start();
    assert.deepEqual(yield* runtime.prompt(prompt), { stopReason: "cancelled" });
  }).pipe(
    Effect.provide(
      Layer.mock(AcpSessionRuntime.AcpSessionRuntime)({
        processContainment: "process-group",
        start,
        prompt: () => Effect.succeed({ stopReason: "cancelled" as const }),
      }),
    ),
  ),
);
