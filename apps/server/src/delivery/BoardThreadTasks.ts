import {
  BoardTaskFiling,
  CommandId,
  DeploymentCompare,
  type DeploymentPortInput,
  type EnvironmentId,
  OrchestratorMcpFailure,
  TurnItemId,
  isReservedBoardTaskBoard,
  type BoardTaskAnswerInput,
  type BoardTaskDraft,
  type BoardTaskOutcome,
  type BoardTaskResolution,
  type DeliveryError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { requireThreadScope, type McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Delivery from "./DeliveryService.ts";
import { threadOrigin } from "./deliveryDiscovery.ts";
import { portDraft, portRequestKey } from "./deploymentPort.ts";

const decodeFiling = Schema.decodeUnknownEffect(BoardTaskFiling);
const decodeCompare = Schema.decodeUnknownEffect(DeploymentCompare);
const decodeRefusal = Schema.decodeUnknownOption(
  Schema.Struct({ code: Schema.optional(Schema.String) }),
);
const refusalOf = (error: DeliveryError) => Option.getOrUndefined(decodeRefusal(error.body));
const invalidRequest = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const sha256 = (text: string) =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    catch: () =>
      new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "Could not derive the board filing request ID.",
      }),
  }).pipe(Effect.map((digest) => Hex.encode(new Uint8Array(digest))));
const noReceipt = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The delivery engine did not return a filing receipt.",
  });
const recordFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Could not record or read the board task confirmation.",
  });

function engineFailure(error: DeliveryError): OrchestratorMcpFailure {
  const refusal = refusalOf(error);
  switch (refusal?.code) {
    case "refused":
    case "not-found":
    case "conflict":
    case "gone":
    case "invalid-field":
      return invalidRequest(error.detail);
    default:
      return new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "Could not confirm the filing through the delivery engine.",
      });
  }
}

export class BoardThreadTasks extends Context.Service<
  BoardThreadTasks,
  {
    readonly request: (
      scope: McpInvocationScope,
      draft: BoardTaskDraft,
    ) => Effect.Effect<BoardTaskOutcome, OrchestratorMcpFailure>;
    readonly answer: (input: BoardTaskAnswerInput) => Effect.Effect<void, OrchestratorMcpFailure>;
    /** Port to app from a release line: a draft filed for the page, not for a thread. */
    readonly filePort: (
      environmentId: EnvironmentId,
      input: DeploymentPortInput,
    ) => Effect.Effect<typeof BoardTaskFiling.Type, OrchestratorMcpFailure>;
  }
>()("t3/delivery/BoardThreadTasks") {}

const make = Effect.gen(function* () {
  const delivery = yield* Delivery.DeliveryService;
  const threads = yield* Threads.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const random = yield* SecureRandom.SecureRandom;
  const hostEnvironment = yield* HostProcess.Environment;
  const pending = new Map<
    TurnItemId,
    (input: BoardTaskAnswerInput) => Effect.Effect<void, OrchestratorMcpFailure>
  >();

  // A transport failure can lose the receipt after commit. Replay the same request once.
  const post = (board: string, body: Record<string, unknown>, configuration: string) => {
    const write = delivery.boardThreadAct({
      method: "POST",
      path: `/api/boards/${board}/tasks`,
      configuration,
      body,
    });
    return write.pipe(
      Effect.catchIf(
        (error) => error.reason === "unreachable" || error.status === 500,
        () => write,
      ),
    );
  };

  const file = Effect.fn("BoardThreadTasks.file")(function* (
    draft: BoardTaskDraft,
    turnItemId: TurnItemId,
    origin: string,
    key: string,
    configuration: string,
  ) {
    const { board, title, body, context } = draft;
    const requestId = yield* sha256(turnItemId);
    const response = yield* post(
      board,
      { requestId, title, body, origin, key, ...(context === undefined ? {} : { context }) },
      configuration,
    ).pipe(Effect.mapError(engineFailure));
    return yield* decodeFiling(response.body).pipe(Effect.mapError(noReceipt));
  });

  const filePort = Effect.fn("BoardThreadTasks.filePort")(function* (
    environmentId: EnvironmentId,
    input: DeploymentPortInput,
  ) {
    const { board, from, to } = input;
    if (isReservedBoardTaskBoard(board))
      return yield* invalidRequest("Choose a custom board to file on.");
    if (from === to) return yield* invalidRequest("Port between two different instances.");
    const key = hostEnvironment[Delivery.BOARD_THREAD_KEY_VARIABLE];
    if (!key) return yield* invalidRequest("This server has no board approval key configured.");
    const configuration = yield* delivery.boardThreadConfiguration;
    // The engine's reading, not the client's, says what is ported and what each commit is.
    const reading = yield* delivery
      .read({
        path: `/api/deployments/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      })
      .pipe(Effect.mapError(engineFailure));
    const compare = yield* decodeCompare(reading.body).pipe(
      Effect.mapError(() =>
        invalidRequest("This engine returned an unsupported compare. Update the engine."),
      ),
    );
    if (compare.from.id !== from || compare.to.id !== to)
      return yield* invalidRequest("The engine compared other instances. Read it again.");
    const composed = portDraft(compare, input.commits, input.requestedBy);
    if (!composed.ok) return yield* invalidRequest(composed.why);
    const { title, body, commits } = composed.draft;
    const origin = `deployment:${environmentId}/${from}..${to}`;
    // One request per board, pair and commits: filing the same port twice replays it.
    const requestId = `port-${yield* sha256(portRequestKey(board, origin, commits))}`;
    const fresh = yield* random.uuidV4().pipe(Effect.mapError(recordFailure));
    // The keyed actor is this environment, as for every server-keyed write: a name the client
    // chose must not open that name's approval window.
    const send = (id: string) =>
      post(
        board,
        { requestId: id, title, body, origin, key, by: environmentId, commits },
        configuration,
      );
    const response = yield* send(requestId).pipe(
      // Its task was discarded since: the engine asks for a new request ID to file it anew.
      Effect.catchIf(
        (error) => refusalOf(error)?.code === "gone",
        () => send(`${requestId.slice(0, 60)}-${fresh}`),
      ),
      Effect.mapError((error) =>
        refusalOf(error)?.code === "conflict"
          ? invalidRequest("Someone else already filed this port. Read the release line again.")
          : engineFailure(error),
      ),
    );
    return yield* decodeFiling(response.body).pipe(Effect.mapError(noReceipt));
  });

  const request = Effect.fn("BoardThreadTasks.request")(function* (
    scope: McpInvocationScope,
    input: BoardTaskDraft,
  ) {
    const caller = yield* requireThreadScope(scope, "Filing a board task");
    const { threadId, providerInstanceId } = caller.thread;
    const { board, title, body, context } = input;
    if (isReservedBoardTaskBoard(board))
      return yield* invalidRequest("Choose a custom board to file on.");

    const key = hostEnvironment[Delivery.BOARD_THREAD_KEY_VARIABLE];
    if (!key) return yield* invalidRequest("This server has no board approval key configured.");
    const origin = threadOrigin(caller.environmentId, threadId);
    const afterSequence = yield* orchestrator
      .getThreadEventSequence(threadId)
      .pipe(Effect.mapError(recordFailure));
    const loadRun = () =>
      threads
        .getThreadRecords(threadId, ["runs"])
        .pipe(Effect.map(Threads.latestActiveRun), Effect.mapError(recordFailure));
    const run = yield* loadRun();
    if (
      run === undefined ||
      run.rootNodeId === null ||
      run.providerInstanceId !== providerInstanceId
    )
      return yield* new OrchestratorMcpFailure({
        code: "parent_not_active",
        message: "Filing a board task requires an active run owned by this MCP provider session.",
      });
    const nodeId = run.rootNodeId;
    const configuration = yield* delivery.boardThreadConfiguration;
    const probe = yield* delivery
      .boardThreadAct({
        method: "POST",
        path: `/api/boards/${board}/tasks`,
        body: { origin, key },
        configuration,
      })
      .pipe(Effect.result);
    if (probe._tag === "Success")
      return yield* invalidRequest(
        "The delivery engine did not refuse the incomplete filing probe.",
      );
    const refusal = refusalOf(probe.failure);
    if (probe.failure.status === 404 && refusal !== undefined && refusal.code === undefined)
      return yield* new OrchestratorMcpFailure({
        code: "unsupported",
        message: "This engine does not take thread filings yet",
      });
    if (probe.failure.status === 404 && refusal?.code === "not-found")
      return yield* invalidRequest("no such board");
    if (probe.failure.status !== 400 || refusal?.code !== "invalid-field")
      return yield* engineFailure(probe.failure);

    const draft = { board, title, body, ...(context === undefined ? {} : { context }) };
    const uuid = yield* random.uuidV4().pipe(Effect.mapError(recordFailure));
    const turnItemId = TurnItemId.make(`turn-item:board-task-request:${uuid}`);
    const answered = yield* Deferred.make<BoardTaskOutcome>();
    const lock = yield* Semaphore.make(1);
    const stillActive = loadRun().pipe(
      Effect.map((current) => current?.id === run.id && current.rootNodeId === nodeId),
    );
    const runEnded = orchestrator.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "thread.deleted" ||
          (event.type === "run.updated" &&
            event.payload.id === run.id &&
            (Threads.isTerminalRunStatus(event.payload.status) ||
              event.payload.rootNodeId !== nodeId)),
      ),
      Stream.runHead,
      Effect.asVoid,
      Effect.mapError(recordFailure),
    );
    const record = (resolution: BoardTaskResolution) =>
      threads
        .dispatch({
          type: "board_task_request.record",
          commandId: CommandId.make(`${turnItemId}:${resolution.status}`),
          threadId,
          runId: run.id,
          nodeId,
          turnItemId,
          draft,
          resolution,
        })
        .pipe(Effect.mapError(recordFailure));
    const settle = (resolution: BoardTaskOutcome) =>
      record(resolution).pipe(
        Effect.catch((error) => Effect.logWarning(error.message)),
        Effect.ensuring(Deferred.succeed(answered, resolution)),
        Effect.asVoid,
      );
    const answer = (input: BoardTaskAnswerInput) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            if (input.threadId !== threadId)
              return yield* invalidRequest("Answer this filing in its original thread.");
            if (yield* Deferred.isDone(answered)) return;
            if (!(yield* stillActive)) return yield* settle({ status: "cancelled" });
            if (input.answer === "decline") return yield* settle({ status: "declined" });
            const result = yield* file(draft, turnItemId, origin, key, configuration).pipe(
              Effect.result,
            );
            yield* settle(
              result._tag === "Success"
                ? { status: "filed", filing: result.success }
                : { status: "failed", message: result.failure.message },
            );
          }),
        )
        .pipe(Effect.uninterruptible);
    const cancel = lock.withPermit(
      Effect.gen(function* () {
        if (!(yield* Deferred.isDone(answered))) yield* settle({ status: "cancelled" });
      }),
    );

    // After File wins the lock, finish recording its receipt even if either client disconnects.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* lock.withPermit(
          Effect.gen(function* () {
            pending.set(turnItemId, answer);
            yield* record({ status: "pending" });
          }),
        );
        return yield* restore(
          Effect.raceFirst(Deferred.await(answered), runEnded).pipe(
            Effect.timeoutOption("10 minutes"),
          ),
        ).pipe(
          Effect.andThen(cancel),
          Effect.andThen(Deferred.await(answered)),
          Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : cancel)),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(turnItemId);
          }),
        ),
      ),
    );
  });

  return BoardThreadTasks.of({
    request,
    filePort,
    answer: Effect.fn("BoardThreadTasks.answer")(function* (input) {
      const respond = pending.get(input.turnItemId);
      if (respond === undefined)
        return yield* invalidRequest("This board task confirmation has closed.");
      yield* respond(input);
    }),
  });
});

export const layer = Layer.effect(BoardThreadTasks, make);

const turnedOff = () => Effect.fail(invalidRequest("Delivery is turned off."));

/** Inert service, for suites that only need the tool surface to resolve. */
export const layerTest = Layer.succeed(
  BoardThreadTasks,
  BoardThreadTasks.of({ request: turnedOff, answer: turnedOff, filePort: turnedOff }),
);
