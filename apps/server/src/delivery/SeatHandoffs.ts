import {
  type DeliveryError,
  DeliveryQaReceiptInput,
  DeliveryQaReceiptResult,
  DeliverySeatAttestation,
  DeliverySeatHandoff,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { type McpInvocationScope, requireThreadScope } from "../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { BOARD_THREAD_KEY_VARIABLE } from "./BoardTaskThreads.ts";
import { boardTaskOfMarker } from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";

const TaskDetail = Schema.Struct({
  acceptance: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  council: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        run: Schema.String,
        seats: Schema.Array(
          Schema.Struct({
            seat: Schema.String,
            threadId: Schema.optional(Schema.NullOr(Schema.String)),
            actualModel: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      }),
    ),
  ),
  roster: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          seat: Schema.String,
          inGate: Schema.optional(Schema.Boolean),
          stages: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
    ),
  ),
  handoffs: Schema.optional(Schema.NullOr(Schema.Array(DeliverySeatHandoff))),
});
const decodeTaskDetail = Schema.decodeUnknownEffect(TaskDetail);
const decodeAttestation = Schema.decodeUnknownEffect(
  Schema.Struct({ attestation: DeliverySeatAttestation }),
);
const decodeReceipt = Schema.decodeUnknownEffect(DeliveryQaReceiptResult);
const decodeRefusal = Schema.decodeUnknownOption(
  Schema.Struct({ code: Schema.optional(Schema.String), field: Schema.optional(Schema.String) }),
);

const refusalOf = (error: DeliveryError) => Option.getOrUndefined(decodeRefusal(error.body));
const invalidRequest = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const missingKey = () => invalidRequest("This server has no board approval key configured.");
const notQaSeat = () =>
  invalidRequest("File QA receipts from an attested QA seat thread for the task's current run.");

const engineFailure = (error: DeliveryError, operation: string) => {
  switch (refusalOf(error)?.code) {
    case "independence":
      return invalidRequest(
        "This seat runs the builder's model. Do not retry. The lead needs a QA seat from a different model.",
      );
    case "moved":
      return invalidRequest("This task is worked on another machine. Continue there.");
    case "refused":
      return invalidRequest(
        "This server has no valid board approval key. Ask the server operator.",
      );
    case "not-found":
      return new OrchestratorMcpFailure({
        code: "task_not_found",
        message:
          "The engine could not find the task or run. Ask the lead to check the current run.",
      });
    case "invalid-field":
      return invalidRequest(`The engine rejected a field while trying to ${operation}.`);
    default:
      return new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: `Could not ${operation} through the delivery engine.`,
      });
  }
};

const checklistChanged = (items: ReadonlyArray<string>) =>
  invalidRequest(
    items.length === 0
      ? "The current checklist has no acceptance items."
      : `Check the current acceptance items before filing again. Use a zero-based acceptanceIndex (item 1 is index 0).\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
  );

export class SeatHandoffs extends Context.Service<
  SeatHandoffs,
  {
    readonly attestSeat: (
      run: string,
      seat: string,
      threadId: ThreadId,
      model: string,
      harness?: string,
    ) => Effect.Effect<
      typeof DeliverySeatAttestation.Type,
      OrchestratorMcpFailure,
      ServerEnvironment.ServerEnvironmentIdentity
    >;
    readonly fileQaReceipt: (
      scope: McpInvocationScope,
      input: typeof DeliveryQaReceiptInput.Type,
    ) => Effect.Effect<typeof DeliveryQaReceiptResult.Type, OrchestratorMcpFailure>;
  }
>()("t3/delivery/SeatHandoffs") {}

const make = Effect.gen(function* () {
  const delivery = yield* DeliveryService.DeliveryService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const hostEnvironment = yield* HostProcess.Environment;

  const readTask = Effect.fn("SeatHandoffs.readTask")(function* (path: string) {
    const response = yield* delivery
      .read({ path })
      .pipe(Effect.mapError((error) => engineFailure(error, "read the board task")));
    return yield* decodeTaskDetail(response.body).pipe(
      Effect.mapError(() => invalidRequest("The engine returned an incompatible board task.")),
    );
  });

  return SeatHandoffs.of({
    attestSeat: Effect.fn("SeatHandoffs.attestSeat")(
      function* (run, seat, threadId, model, harness) {
        const key = hostEnvironment[BOARD_THREAD_KEY_VARIABLE];
        if (!key) return yield* missingKey();
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        const environmentId = yield* identity.getEnvironmentId;
        const response = yield* delivery
          .boardThreadAct({
            method: "POST",
            path: `/api/runs/${run}/seat-attestations`,
            body: { seat, environmentId, threadId, model, harness, setBy: environmentId, key },
          })
          .pipe(Effect.mapError((error) => engineFailure(error, "attest the seat")));
        const { attestation } = yield* decodeAttestation(response.body).pipe(
          Effect.mapError(() => invalidRequest("The engine did not return a seat attestation.")),
        );
        return attestation;
      },
    ),
    fileQaReceipt: Effect.fn("SeatHandoffs.fileQaReceipt")(function* (scope, input) {
      const caller = yield* requireThreadScope(scope, "Filing a QA receipt");
      const environmentId = caller.environmentId;
      const key = hostEnvironment[BOARD_THREAD_KEY_VARIABLE];
      if (!key) return yield* missingKey();

      const findThread = (threadId: ThreadId) =>
        threads.getThreadShell(threadId).pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "Could not read the QA thread's lineage.",
              }),
          ),
        );
      const thread = yield* findThread(caller.thread.threadId);
      const parentId = thread?.lineage.parentThreadId;
      if (!parentId) return yield* notQaSeat();
      const parent = yield* findThread(parentId);
      const task = boardTaskOfMarker(parent?.lineage.engineIntake);
      if (!task) return yield* notQaSeat();

      const path = `/api/tasks/${task.id}`;
      const detail = yield* readTask(path);
      const council = detail.council;
      const seat = council?.seats.find((entry) => entry.threadId === caller.thread.threadId);
      if (!council?.run || !seat?.seat || !seat.actualModel || !seat.threadId)
        return yield* notQaSeat();

      const roster = detail.roster ?? [];
      const duty = roster.find((entry) => entry.seat === seat.seat);
      const inQa = roster.some((entry) => entry.inGate)
        ? duty?.inGate
        : duty?.stages?.includes("qa");
      const handoff = detail.handoffs?.find(
        (entry) =>
          entry.run === council.run &&
          entry.stage === "qa" &&
          entry.seat === seat.seat &&
          entry.seatThread?.threadId === seat.threadId,
      );
      const seatEnvironment = handoff?.seatThread?.environmentId ?? environmentId;
      if ((!inQa && !handoff) || seatEnvironment !== environmentId) return yield* notQaSeat();

      const items = detail.acceptance ?? [];
      const item = items[input.acceptanceIndex];
      if (item === undefined) return yield* checklistChanged(items);
      const digest = yield* Effect.tryPromise({
        try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(item)),
        catch: () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "Could not hash the acceptance item.",
          }),
      });
      const hash = Hex.encode(new Uint8Array(digest).subarray(0, 8));
      const filed = yield* delivery
        .boardThreadAct({
          method: "POST",
          path: `${path}/qa-receipts`,
          body: {
            run: council.run,
            seat: seat.seat,
            seatThread: { environmentId: seatEnvironment, threadId: seat.threadId },
            acceptance: { index: input.acceptanceIndex, hash },
            verdict: input.verdict,
            evidence: input.evidence,
            filedBy: environmentId,
            key,
          },
        })
        .pipe(Effect.result);
      if (filed._tag === "Failure") {
        const refusal = refusalOf(filed.failure);
        if (
          refusal?.code === "invalid-field" &&
          (refusal.field === "acceptance.hash" || refusal.field === "acceptance.index")
        ) {
          const latest = yield* readTask(path);
          return yield* checklistChanged(latest.acceptance ?? []);
        }
        return yield* engineFailure(filed.failure, "file the QA receipt");
      }
      return yield* decodeReceipt(filed.success.body).pipe(
        Effect.mapError(() => invalidRequest("The engine did not return a QA receipt.")),
      );
    }),
  });
});

export const layer = Layer.effect(SeatHandoffs, make);
