import {
  DELIVERY_HARNESS_BY_DRIVER,
  type DeliveryError,
  DeliveryQaReceiptInput,
  DeliveryQaReceiptResult,
  DeliveryQaReceipt,
  DeliverySeatAttestation,
  DeliverySeatHandoff,
  DeliverySeatHandoffInput,
  DeliverySeatHandoffResult,
  type EnvironmentId,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  type McpInvocationScope,
  type McpThreadInvocationScope,
  requireThreadScope,
} from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { BOARD_THREAD_KEY_VARIABLE } from "./BoardTaskThreads.ts";
import { boardTaskOfMarker } from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";
import { resolveSeatProvider } from "./seatProvider.ts";

const SeatThread = Schema.Struct({ environmentId: Schema.String, threadId: Schema.String });
const optionalString = Schema.optional(Schema.NullOr(Schema.String));
const TaskDetail = Schema.Struct({
  title: optionalString,
  body: optionalString,
  boardThread: Schema.optional(Schema.NullOr(SeatThread)),
  acceptance: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  council: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        run: Schema.String,
        candidate: optionalString,
        base: optionalString,
        seats: Schema.Array(
          Schema.Struct({
            seat: Schema.String,
            threadId: optionalString,
            seatThread: Schema.optional(Schema.NullOr(SeatThread)),
            actualModel: optionalString,
            requestedModel: optionalString,
            harness: optionalString,
            currentModel: Schema.optional(
              Schema.NullOr(Schema.Struct({ model: optionalString, harness: optionalString })),
            ),
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
  qaReceipts: Schema.optional(Schema.NullOr(Schema.Array(DeliveryQaReceipt))),
});
type TaskDetail = typeof TaskDetail.Type;
const decodeTaskDetail = Schema.decodeUnknownEffect(TaskDetail);
const decodeAttestation = Schema.decodeUnknownEffect(
  Schema.Struct({ attestation: DeliverySeatAttestation }),
);
const decodeReceipt = Schema.decodeUnknownEffect(DeliveryQaReceiptResult);
const decodeHandoff = Schema.decodeUnknownEffect(Schema.Struct({ handoff: DeliverySeatHandoff }));
const readHandoff = Effect.fn("SeatHandoffs.readHandoff")(function* (body: unknown, run: string) {
  const { handoff } = yield* decodeHandoff(body).pipe(
    Effect.mapError(() => invalidRequest("The engine did not return a QA hand-off.")),
  );
  if (handoff.run !== run || handoff.stage !== "qa" || !handoff.state)
    return yield* invalidRequest("The engine did not return this run's QA hand-off.");
  return handoff;
});
const decodeRefusal = Schema.decodeUnknownOption(
  Schema.Struct({
    code: Schema.optional(Schema.String),
    field: Schema.optional(Schema.String),
    current: Schema.optional(Schema.Unknown),
  }),
);

const refusalOf = (error: DeliveryError) => Option.getOrUndefined(decodeRefusal(error.body));
const invalidRequest = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const missingKey = () => invalidRequest("This server has no board approval key configured.");
const notQaSeat = () =>
  invalidRequest("File QA receipts from an attested QA seat thread for the task's current run.");
const notLead = () => invalidRequest("Only this board task's lead thread can hand off QA.");
const working = (handoff: typeof DeliverySeatHandoff.Type) => ({
  handoff,
  state: "working" as const,
  next: "Completion wakes this thread, so end your turn and call delivery_seat_handoff again after the notification; do not poll.",
});

const qaGateSeats = (detail: TaskDetail) => {
  const roster = detail.roster ?? [];
  return roster.some((entry) => entry.inGate)
    ? roster.filter((entry) => entry.inGate)
    : roster.filter((entry) => entry.stages?.includes("qa"));
};

const currentQaHandoff = (detail: TaskDetail, run: string) =>
  detail.handoffs?.find((entry) => entry.run === run && entry.stage === "qa");

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
    readonly handQa: (
      scope: McpInvocationScope,
      input: Pick<typeof DeliverySeatHandoffInput.Type, "seat">,
    ) => Effect.Effect<typeof DeliverySeatHandoffResult.Type, OrchestratorMcpFailure>;
  }
>()("t3/delivery/SeatHandoffs") {}

const make = Effect.gen(function* () {
  const delivery = yield* DeliveryService.DeliveryService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const orchestrator = yield* OrchestratorMcpService.OrchestratorMcpService;
  const hostEnvironment = yield* HostProcess.Environment;
  const handoffLock = yield* Semaphore.make(1);

  const readTask = Effect.fn("SeatHandoffs.readTask")(function* (path: string) {
    const response = yield* delivery
      .read({ path })
      .pipe(Effect.mapError((error) => engineFailure(error, "read the board task")));
    return yield* decodeTaskDetail(response.body).pipe(
      Effect.mapError(() => invalidRequest("The engine returned an incompatible board task.")),
    );
  });

  const attestSeatAs = Effect.fn("SeatHandoffs.attestSeatAs")(function* (
    environmentId: EnvironmentId,
    run: string,
    seat: string,
    threadId: ThreadId,
    model: string,
    harness?: string,
  ) {
    const key = hostEnvironment[BOARD_THREAD_KEY_VARIABLE];
    if (!key) return yield* missingKey();
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
  });

  const findThread = Effect.fn("SeatHandoffs.findThread")((threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "Could not read the thread's lineage.",
          }),
      ),
    ),
  );

  const launchQaSeat = Effect.fn("SeatHandoffs.launchQaSeat")(function* (
    detail: TaskDetail,
    council: NonNullable<TaskDetail["council"]>,
    caller: McpThreadInvocationScope,
    filing: number,
    namedSeat: string | undefined,
  ) {
    if (!detail.title || !council.candidate || !council.base)
      return yield* invalidRequest(
        "The board task needs a title, candidate commit and base to hand off QA.",
      );
    const gates = qaGateSeats(detail).flatMap(
      ({ seat }) => council.seats.find((entry) => entry.seat === seat) ?? [],
    );
    const capabilities = yield* orchestrator.capabilities(caller);
    const providers = capabilities.providers.filter((provider) => provider.canRunChildTask);
    const nativeScope = {
      ...caller,
      requestNamespace: `delivery-handoff:${council.run}:qa:${filing}`,
    };
    const prompt = [
      `Task: ${detail.title}`,
      detail.body ?? "",
      "Acceptance items (zero-based indexes):",
      ...(detail.acceptance ?? []).map((item, index) => `${index}. ${item}`),
      `Candidate commit: ${council.candidate}`,
      `Base commit: ${council.base}`,
      "Check out the candidate commit in your worktree and test it. Do not edit code. File receipts only after testing.",
      "File exactly one delivery_qa_receipt for each acceptance item with its zero-based index, a pass, fail or blocked verdict, and evidence refs. Then end your turn.",
    ].join("\n");
    for (const seat of gates) {
      if (namedSeat !== undefined && seat.seat !== namedSeat) continue;
      const { model, harness } = seat.currentModel ?? {
        model: seat.requestedModel,
        harness: seat.harness,
      };
      if (!model || !harness) continue;
      const provider = resolveSeatProvider(providers, harness, (entry) => entry.providerInstanceId);
      if (typeof provider === "string") continue;

      const delegated = yield* orchestrator
        .delegateTask(nativeScope, {
          task: prompt,
          clientRequestId: seat.seat,
          isolation: "worktree",
          mode: "async",
          target: { providerInstanceId: provider.providerInstanceId, model, options: [] },
        })
        .pipe(Effect.result);
      if (delegated._tag === "Failure") {
        if (
          namedSeat === undefined &&
          (delegated.failure.code === "model_unavailable" ||
            delegated.failure.code === "provider_unavailable")
        )
          continue;
        return yield* delegated.failure;
      }
      const child = delegated.success;
      const launchedProvider = capabilities.providers.find(
        (entry) => entry.providerInstanceId === child.providerInstanceId,
      );
      const launchedHarness =
        launchedProvider && DELIVERY_HARNESS_BY_DRIVER[launchedProvider.driverKind];
      if (!child.childThreadId || !child.model || !launchedHarness)
        return yield* invalidRequest(
          "T3 did not return the launched QA thread, model and harness. Retry to recover the delegation.",
        );
      return {
        name: seat.seat,
        threadId: child.childThreadId,
        model: child.model,
        harness: launchedHarness,
        taskId: child.taskId,
        scope: nativeScope,
        otherSeats: gates.filter((entry) => entry !== seat).map((entry) => entry.seat),
      };
    }
    return yield* invalidRequest(
      namedSeat === undefined
        ? "No QA gate seat has a launchable model and provider."
        : "The named seat is not a QA gate seat with a launchable model and provider.",
    );
  });

  return SeatHandoffs.of({
    attestSeat: Effect.fn("SeatHandoffs.attestSeat")(
      function* (run, seat, threadId, model, harness) {
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        return yield* attestSeatAs(
          yield* identity.getEnvironmentId,
          run,
          seat,
          threadId,
          model,
          harness,
        );
      },
    ),
    handQa: Effect.fn("SeatHandoffs.handQa")(
      function* (scope, input) {
        const caller = yield* requireThreadScope(scope, "Handing off QA");
        const {
          environmentId,
          thread: { threadId },
        } = caller;
        const lead = yield* findThread(threadId);
        const task = boardTaskOfMarker(lead?.lineage.engineIntake);
        if (!task) return yield* notLead();
        const key = hostEnvironment[BOARD_THREAD_KEY_VARIABLE];
        if (!key) return yield* missingKey();

        const path = `/api/tasks/${task.id}`;
        const isLead = (detail: TaskDetail) =>
          detail.boardThread?.environmentId === environmentId &&
          detail.boardThread.threadId === threadId;
        const detail = yield* readTask(path);
        if (!isLead(detail)) return yield* notLead();
        const council = detail.council;
        if (!council?.run) return yield* invalidRequest("The board task has no current run.");
        const { run } = council;
        const endpoint = `/api/runs/${encodeURIComponent(run)}/handoffs`;
        const post = (action: string, body: Record<string, string>) =>
          delivery.boardThreadAct({
            method: "POST",
            path: endpoint + action,
            body: { ...body, setBy: environmentId, key },
          });
        let current = currentQaHandoff(detail, run);
        if (current?.state !== "handed") {
          if (current && current.id == null)
            return yield* invalidRequest("The engine's previous QA hand-off has no filing id.");
          // The engine serves the latest filing only. Its id distinguishes a new filing from a retry.
          const filing = current?.id == null ? 0 : current.id + 1;
          const seat = yield* launchQaSeat(detail, council, caller, filing, input.seat);
          yield* attestSeatAs(
            environmentId,
            run,
            seat.name,
            seat.threadId,
            seat.model,
            seat.harness,
          );
          const handed = yield* post("", { stage: "qa", seat: seat.name }).pipe(Effect.result);
          if (handed._tag === "Success") {
            const handoff = yield* readHandoff(handed.success.body, run);
            if (
              handoff.state !== "handed" ||
              handoff.seat !== seat.name ||
              handoff.seatThread?.environmentId !== environmentId ||
              handoff.seatThread.threadId !== seat.threadId
            )
              return yield* invalidRequest("The engine did not hand QA to the launched seat.");
            return working(handoff);
          }
          const refusal = refusalOf(handed.failure);
          const held =
            handed.failure.status === 409 && refusal?.code === "conflict"
              ? yield* readHandoff({ handoff: refusal.current }, run)
              : undefined;
          // A seat the engine did not take must not go on to file receipts.
          if (held?.seatThread?.threadId !== seat.threadId)
            yield* orchestrator
              .cancelTask(seat.scope, {
                taskId: seat.taskId,
                clientRequestId: "handoff-refused",
                reason: "The delivery engine refused this QA hand-off.",
              })
              .pipe(Effect.ignore);
          if (handed.failure.status === 409 && refusal?.code === "independence")
            return yield* invalidRequest(
              `That QA seat shares the builder's model family; pick another seat (seat: ${seat.otherSeats.join(", ") || "none"})`,
            );
          if (held === undefined) return yield* engineFailure(handed.failure, "hand off QA");
          current = held;
          if (current.state === "delivered" || current.state === "fallen-back")
            return { state: current.state, handoff: current };
        }

        if (current.seatThread?.environmentId !== environmentId || !current.seatThread.threadId)
          return yield* invalidRequest("This run's QA hand-off belongs to another environment.");
        const childId = ThreadId.make(current.seatThread.threadId);
        const child = yield* findThread(childId);
        // T3 links the delegated child to the lead's task node when it creates the thread.
        if (child?.lineage.parentThreadId !== threadId || child.forkedFrom?.type !== "node")
          return yield* invalidRequest(
            "This run's QA hand-off has no delegated child of this lead.",
          );
        const status = yield* orchestrator.taskStatus(caller, child.forkedFrom.nodeId);
        if (status.childThreadId !== childId)
          return yield* invalidRequest("The delegated task does not match the handed QA thread.");
        if (
          status.workState !== "result_available" ||
          status.hasPendingChildRuns ||
          !status.latestTerminalStatus
        )
          return working(current);

        const latest = yield* readTask(path);
        if (!isLead(latest)) return yield* notLead();
        const handoff = currentQaHandoff(latest, run);
        if (
          latest.council?.run !== run ||
          !handoff ||
          handoff.seatThread?.threadId !== childId ||
          handoff.seatThread.environmentId !== environmentId
        )
          return yield* invalidRequest(
            "The run or its QA hand-off changed. Read the current board task.",
          );
        if (handoff.state === "delivered" || handoff.state === "fallen-back")
          return { state: handoff.state, handoff };
        if (handoff.state !== "handed" || handoff.id !== current.id)
          return yield* invalidRequest("The QA hand-off changed. Read the current board task.");

        const received = new Set(
          latest.qaReceipts
            ?.filter((receipt) => receipt.run === run && receipt.seat === handoff.seat)
            .map((receipt) => receipt.acceptance?.index),
        );
        const reason =
          status.latestTerminalStatus !== "completed"
            ? "seat-failed"
            : (latest.acceptance ?? []).every((_, index) => received.has(index))
              ? undefined
              : "no-receipts";
        const settled = yield* post(
          reason ? "/qa/fallback" : "/qa/delivered",
          reason ? { reason } : {},
        ).pipe(Effect.result);
        let body: unknown;
        if (settled._tag === "Success") {
          body = settled.success.body;
        } else {
          const refusal = refusalOf(settled.failure);
          if (settled.failure.status !== 409 || refusal?.code !== "conflict")
            return yield* engineFailure(settled.failure, "settle the QA hand-off");
          body = { handoff: refusal.current };
        }
        const recorded = yield* readHandoff(body, run);
        if (
          recorded.seatThread?.environmentId !== environmentId ||
          recorded.seatThread.threadId !== childId ||
          (recorded.state !== "delivered" && recorded.state !== "fallen-back")
        )
          return yield* invalidRequest(
            "The engine did not return this seat's settled QA hand-off.",
          );
        return { state: recorded.state, handoff: recorded };
      },
      (effect) => handoffLock.withPermit(effect),
    ),
    fileQaReceipt: Effect.fn("SeatHandoffs.fileQaReceipt")(function* (scope, input) {
      const caller = yield* requireThreadScope(scope, "Filing a QA receipt");
      const environmentId = caller.environmentId;
      const key = hostEnvironment[BOARD_THREAD_KEY_VARIABLE];
      if (!key) return yield* missingKey();

      const thread = yield* findThread(caller.thread.threadId);
      const parentId = thread?.lineage.parentThreadId;
      if (!parentId) return yield* notQaSeat();
      const parent = yield* findThread(parentId);
      const task = boardTaskOfMarker(parent?.lineage.engineIntake);
      if (!task) return yield* notQaSeat();

      const path = `/api/tasks/${task.id}`;
      const detail = yield* readTask(path);
      const council = detail.council;
      const seat = council?.seats.find(
        (entry) =>
          (entry.seatThread === undefined ? entry.threadId : entry.seatThread?.threadId) ===
          caller.thread.threadId,
      );
      // A seat starts before the lead's attestation lands, so an early filing is asked to retry.
      if (!council?.run || !seat?.seat || !seat.actualModel)
        return yield* invalidRequest(
          "This QA seat is not attested for the task's current run yet. Finish testing, then file again; if it still fails, end your turn and report it.",
        );

      const inQa = qaGateSeats(detail).some((entry) => entry.seat === seat.seat);
      const handoff = detail.handoffs?.find(
        (entry) =>
          entry.run === council.run &&
          entry.stage === "qa" &&
          entry.seat === seat.seat &&
          entry.seatThread?.threadId === caller.thread.threadId,
      );
      const seatThread =
        seat.seatThread === undefined
          ? {
              environmentId: handoff?.seatThread?.environmentId ?? environmentId,
              threadId: caller.thread.threadId,
            }
          : seat.seatThread;
      if ((!inQa && !handoff) || seatThread?.environmentId !== environmentId)
        return yield* notQaSeat();

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
            seatThread,
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
