/**
 * Kimi Code ACP adapter.
 *
 * Keeps one `kimi acp` process per thread and translates its ACP traffic into
 * orchestration events. The protocol plumbing is the shared ACP stack —
 * `AcpSessionRuntime` for the transport and session, `AcpRuntimeModel` for
 * parsing, `AcpCoreRuntimeEvents` for the canonical event shapes — so what
 * lives here is only the Kimi-specific lifecycle.
 *
 * Deliberately narrower than the Antigravity and Grok adapters: Kimi's ACP
 * surface has no subagent batches, no backgrounded commands and no plan mode,
 * so there is no task linkage to track. Conversation rewind is likewise absent
 * from the agent, and `rollbackThread` reports that rather than faking it.
 *
 * @module provider/Layers/KimiAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  TurnId,
  type KimiSettings,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  type TurnCompletedPayload,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  currentKimiModelIdFromSessionSetup,
  resolveKimiAcpModelId,
  type KimiAcpRuntimeInput,
} from "../acp/KimiAcpSupport.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("kimi");

const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
});
const decodeResumeCursor = Schema.decodeUnknownOption(ResumeCursor);
const isAcpError = Schema.is(EffectAcpErrors.AcpError);

type Adapter = ProviderAdapterShape<ProviderAdapterError>;
type Runtime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  | "handleRequestPermission"
  | "start"
  | "setSessionModel"
  | "getEvents"
  | "drainEvents"
  | "prompt"
  | "cancel"
>;
type NativePermission = EffectAcpSchema.RequestPermissionRequest;
type NativePermissionResponse = EffectAcpSchema.RequestPermissionResponse;

/**
 * Pick the option id matching the user's decision from the choices the agent
 * offered. ACP option `kind`s are standard, so no Kimi-specific mapping is
 * needed; `undefined` means the agent did not offer that choice.
 */
export function selectKimiPermissionOptionId(
  request: NativePermission,
  decision: ProviderApprovalDecision,
): string | undefined {
  const byKind = (...kinds: ReadonlyArray<string>) =>
    request.options.find((option) => kinds.includes(option.kind))?.optionId;
  switch (decision) {
    case "acceptForSession":
      return byKind("allow_always", "allow_once");
    case "accept":
      return byKind("allow_once", "allow_always");
    case "decline":
      return byKind("reject_once", "reject_always");
    default:
      return undefined;
  }
}

/**
 * Offer only the decisions the agent actually advertised, so the approval UI
 * never shows a choice Kimi would reject. Cancel is always available because
 * the client can abandon a request regardless of the offered options.
 */
export function kimiApprovalOptions(
  request: NativePermission,
): ReadonlyArray<ProviderApprovalOption> {
  const optionWithKind = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.find((entry) => entry.kind === kind && entry.optionId.trim());
  const options: Array<ProviderApprovalOption> = [];
  if (optionWithKind("allow_once")) options.push({ decision: "accept", label: "Allow once" });
  if (optionWithKind("allow_always")) {
    options.push({ decision: "acceptForSession", label: "Allow for this thread" });
  }
  if (optionWithKind("reject_once")) options.push({ decision: "decline", label: "Deny" });
  options.push({ decision: "cancel", label: "Cancel" });
  return options;
}

interface PendingApproval {
  readonly request: NativePermission;
  readonly response: Deferred.Deferred<{
    readonly decision: ProviderApprovalDecision;
    readonly result: NativePermissionResponse;
  }>;
}

interface TurnIntent {
  readonly turnId: TurnId;
  readonly generation: number;
  settled: boolean;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly nativeSessionId: string;
  readonly scope: Scope.Closeable;
  readonly runtime: Runtime;
  readonly promptLock: Semaphore.Semaphore;
  readonly stopLock: Semaphore.Semaphore;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  promptFiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> | undefined;
  generation: number;
  stopped: boolean;
  closed: boolean;
  disconnected: boolean;
}

export interface KimiAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly makeRuntime: (
    input: Omit<KimiAcpRuntimeInput, "childProcessSpawner" | "kimiSettings" | "environment">,
  ) => Effect.Effect<Runtime, EffectAcpErrors.AcpError, Scope.Scope>;
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onAvailableCommands?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly defaultModel?: Effect.Effect<string | undefined>;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

/** Keeps one `kimi acp` process per thread and drains a cancelled prompt before steering. */
export const makeKimiAdapter = Effect.fn("makeKimiAdapter")(function* (
  settings: KimiSettings,
  options: KimiAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const ownerScope = yield* Effect.scope;
  const makeNativeLoggers = yield* makeAcpNativeLoggerFactory();
  const sessions = new Map<ThreadId, SessionContext>();
  const locks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create a Kimi event ID.",
          cause,
        }),
    ),
  );
  const stamp = Effect.all({
    eventId: Effect.map(randomId, EventId.make),
    createdAt: nowIso,
  });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

  const withThreadLock = <A, E, R>(threadId: ThreadId, task: Effect.Effect<A, E, R>) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = current.get(threadId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((lock) => [lock, new Map(current).set(threadId, lock)] as const),
      );
    }).pipe(Effect.flatMap((lock) => lock.withPermit(task)));

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const cancelRequests = Effect.fn("KimiAdapter.cancelRequests")(function* (
    context: SessionContext,
  ) {
    for (const pending of context.approvals.values()) {
      yield* Deferred.succeed(pending.response, {
        decision: "cancel",
        result: { outcome: { outcome: "cancelled" } },
      });
    }
  });

  const stopContext = (context: SessionContext) =>
    context.stopLock
      .withPermit(
        Effect.gen(function* () {
          if (context.closed) return;
          context.stopped = true;
          yield* Effect.gen(function* () {
            yield* cancelRequests(context);
            if (context.promptFiber && !context.disconnected) {
              yield* Effect.ignore(context.runtime.cancel);
            }
          }).pipe(Effect.ensuring(Scope.close(context.scope, Exit.void)));
          context.closed = true;
          if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
          yield* emit({
            type: "session.exited",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            payload: {
              exitKind: context.disconnected ? "error" : "graceful",
              ...(context.disconnected ? { reason: "Kimi process stopped." } : {}),
            },
          });
        }),
      )
      .pipe(Effect.uninterruptible);

  const handlePermission = Effect.fn("KimiAdapter.handlePermission")(function* (
    context: SessionContext,
    request: NativePermission,
  ): Effect.fn.Return<NativePermissionResponse, ProviderAdapterError> {
    if (context.stopped || request.sessionId !== context.nativeSessionId) {
      return { outcome: { outcome: "cancelled" } };
    }
    const requestId = ApprovalRequestId.make(yield* randomId);
    const runtimeRequestId = RuntimeRequestId.make(requestId);
    const turnId = context.activeTurnId;
    const response = yield* Deferred.make<{
      decision: ProviderApprovalDecision;
      result: NativePermissionResponse;
    }>();
    context.approvals.set(requestId, { request, response });
    const parsed = parsePermissionRequest(request);
    const permissionRequest = {
      ...parsed,
      detail: parsed.detail ?? "Kimi requests permission.",
    };
    return yield* Effect.gen(function* () {
      yield* emit(
        makeAcpRequestOpenedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          approvalOptions: kimiApprovalOptions(request),
          detail: permissionRequest.detail,
          args: request,
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload: request,
        }),
      );
      const answer = yield* Deferred.await(response);
      yield* emit(
        makeAcpRequestResolvedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          decision: answer.decision,
        }),
      );
      return answer.result;
    }).pipe(Effect.ensuring(Effect.sync(() => context.approvals.delete(requestId))));
  });

  const handleEvent = Effect.fn("KimiAdapter.handleEvent")(function* (
    context: SessionContext,
    event: AcpSessionRuntime.AcpSessionRuntimeEvent,
  ) {
    if (event._tag === "EventStreamBarrier") {
      yield* Deferred.succeed(event.acknowledge, undefined);
      return;
    }
    if (context.stopped) return;
    switch (event._tag) {
      case "ModeChanged":
      case "ConfigOptionsUpdated":
        return;
      case "AvailableCommandsUpdated":
        yield* options.onAvailableCommands?.(event.availableCommands, context.cwd) ?? Effect.void;
        return;
      case "ConnectionTerminated":
        context.stopped = true;
        context.disconnected = true;
        yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
        return;
      case "AssistantItemStarted":
      case "AssistantItemCompleted":
        yield* emit(
          makeAcpAssistantItemEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            itemId: event.itemId,
            lifecycle: event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
          }),
        );
        return;
      case "ThoughtDelta":
      case "ContentDelta":
        yield* emit(
          makeAcpContentDeltaEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            ...(event._tag === "ContentDelta" && event.itemId ? { itemId: event.itemId } : {}),
            ...(event._tag === "ThoughtDelta" ? { streamKind: "reasoning_text" as const } : {}),
            text: event.text,
            rawPayload: event.rawPayload,
          }),
        );
        return;
      case "PlanUpdated":
        yield* emit(
          makeAcpPlanUpdatedEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            payload: event.payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload: event.rawPayload,
          }),
        );
        return;
      case "ToolCallUpdated":
        yield* emit(
          makeAcpToolCallEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            toolCall: event.toolCall,
            rawPayload: event.rawPayload,
          }),
        );
        return;
    }
  });

  const startSession: Adapter["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (!settings.enabled) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Enable Kimi in provider settings before starting a thread.",
          });
        }
        if (
          (input.provider !== undefined && input.provider !== PROVIDER) ||
          (input.providerInstanceId !== undefined &&
            input.providerInstanceId !== options.instanceId) ||
          (input.modelSelection !== undefined &&
            input.modelSelection.instanceId !== options.instanceId)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The Kimi provider instance does not match the requested session.",
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The session requires a workspace directory.",
          });
        }
        const cursor = decodeResumeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && Option.isNone(cursor)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The saved Kimi session is invalid. Start a new thread.",
          });
        }
        const previous = sessions.get(input.threadId);
        if (previous) yield* stopContext(previous);
        const cwd = input.cwd;
        const sessionScope = yield* Scope.make("sequential");
        let transferred = false;
        let context: SessionContext | undefined;
        yield* Effect.addFinalizer(() => {
          if (transferred) return Effect.void;
          sessions.delete(input.threadId);
          return Scope.close(sessionScope, Exit.void);
        });

        return yield* Effect.gen(function* () {
          const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
          const runtime = yield* options.makeRuntime({
            cwd,
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(Option.isSome(cursor) ? { resumeSessionId: cursor.value.sessionId } : {}),
            mcpServers: mcp
              ? [
                  {
                    type: "http",
                    name: "t3-code",
                    url: mcp.endpoint,
                    headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
                  },
                ]
              : [],
            ...makeNativeLoggers({
              nativeEventLogger: options.nativeEventLogger,
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          });
          yield* runtime.handleRequestPermission((request) =>
            context
              ? handlePermission(context, request).pipe(
                  Effect.mapError((cause) =>
                    EffectAcpErrors.AcpRequestError.internalError(
                      "Could not process a Kimi permission request.",
                      undefined,
                      { cause },
                    ),
                  ),
                )
              : Effect.succeed({
                  outcome: { outcome: "cancelled" },
                } satisfies NativePermissionResponse),
          );
          const started = yield* runtime.start();
          const requestedModel = input.modelSelection?.model;
          const model =
            requestedModel ?? currentKimiModelIdFromSessionSetup(started.sessionSetupResult);
          if (requestedModel) {
            yield* runtime.setSessionModel(resolveKimiAcpModelId(requestedModel));
          }
          yield* options.onSessionStarted?.(started, cwd) ?? Effect.void;
          const createdAt = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            cwd,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(model ? { model } : {}),
            resumeCursor: { schemaVersion: 1, sessionId: started.sessionId },
            createdAt,
            updatedAt: createdAt,
          };
          context = {
            threadId: input.threadId,
            cwd,
            nativeSessionId: started.sessionId,
            scope: sessionScope,
            runtime,
            promptLock: yield* Semaphore.make(1),
            stopLock: yield* Semaphore.make(1),
            approvals: new Map(),
            turns: [],
            session,
            activeTurnId: undefined,
            promptFiber: undefined,
            generation: 0,
            stopped: false,
            closed: false,
            disconnected: false,
          };
          const running = context;
          sessions.set(input.threadId, running);
          yield* Stream.runForEach(runtime.getEvents(), (event) =>
            handleEvent(running, event),
          ).pipe(
            Effect.catchCause(() => Effect.logError("Could not process a Kimi runtime event.")),
            Effect.forkIn(sessionScope),
          );
          yield* emit({
            type: "session.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* emit({
            type: "session.state.changed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Kimi ACP session ready" },
          });
          yield* emit({
            type: "thread.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          yield* runtime.drainEvents;
          if (running.stopped) {
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          transferred = true;
          return session;
        }).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError((cause) =>
            isAcpError(cause)
              ? mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause)
              : cause,
          ),
        );
      }).pipe(Effect.scoped),
    );

  const sendTurn: Adapter["sendTurn"] = Effect.fn("KimiAdapter.sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "The selected model belongs to another provider instance.",
      });
    }
    const text = input.input?.trim();
    if (!text) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Kimi turns need a prompt.",
      });
    }
    let intent: TurnIntent | undefined;
    const finishTurn = (turn: TurnIntent, payload: TurnCompletedPayload) =>
      Effect.gen(function* () {
        if (turn.settled || context.stopped || context.generation !== turn.generation) return;
        turn.settled = true;
        context.activeTurnId = undefined;
        context.promptFiber = undefined;
        context.session = {
          ...context.session,
          status: payload.state === "failed" ? "error" : "ready",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
          ...(payload.errorMessage
            ? { lastError: payload.errorMessage }
            : { lastError: undefined }),
        };
        yield* emit({
          type: "turn.completed",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId: turn.turnId,
          payload,
        });
      }).pipe(Effect.uninterruptible);

    return yield* Effect.gen(function* () {
      const launch = yield* context.promptLock.withPermit(
        Effect.gen(function* () {
          yield* requireSession(input.threadId);
          const model = input.modelSelection?.model ?? context.session.model;
          const turnId = context.activeTurnId ?? TurnId.make(yield* randomId);
          const steering = context.activeTurnId !== undefined;
          const turn: TurnIntent = { turnId, generation: ++context.generation, settled: false };
          intent = turn;
          context.activeTurnId = turnId;
          if (!steering) {
            yield* emit({
              type: "turn.started",
              ...(yield* stamp),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: model ? { model } : {},
            });
          }
          if (context.promptFiber) {
            yield* cancelRequests(context);
            yield* context.runtime.cancel;
            yield* Fiber.await(context.promptFiber);
          }
          if (input.modelSelection?.model) {
            yield* context.runtime.setSessionModel(
              resolveKimiAcpModelId(input.modelSelection.model),
            );
          }
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            ...(model ? { model } : {}),
            updatedAt: yield* nowIso,
          };
          const dispatched = yield* Deferred.make<void>();
          const fiber = yield* context.runtime
            .prompt(
              {
                prompt: [
                  { type: "text", text },
                  {
                    type: "text",
                    text: buildRuntimeInstructions({ harness: "Kimi", model }),
                  },
                ],
              },
              { dispatched },
            )
            .pipe(Effect.forkIn(context.scope));
          context.promptFiber = fiber;
          // Fiber.join can skip a scope-close waiter when the child is interrupted.
          // Unwrap the Exit after Fiber.await returns.
          yield* Effect.raceFirst(
            Deferred.await(dispatched),
            Fiber.await(fiber).pipe(
              Effect.flatMap((exit) => exit),
              Effect.asVoid,
            ),
          );
          return { turn, fiber };
        }),
      );
      const result = yield* Fiber.await(launch.fiber).pipe(Effect.flatMap((exit) => exit));
      yield* context.runtime.drainEvents;
      if (context.stopped) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: input.threadId,
        });
      }
      const record = context.turns.find((turn) => turn.id === launch.turn.turnId);
      if (record) record.items.push(result);
      else context.turns.push({ id: launch.turn.turnId, items: [result] });
      yield* context.promptLock.withPermit(
        finishTurn(launch.turn, {
          state: result.stopReason === "cancelled" ? "cancelled" : "completed",
          stopReason: result.stopReason,
        }),
      );
      return {
        threadId: input.threadId,
        turnId: launch.turn.turnId,
        resumeCursor: context.session.resumeCursor,
      };
    }).pipe(
      Effect.mapError((cause) =>
        isAcpError(cause)
          ? mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", cause)
          : cause,
      ),
      Effect.tapError((cause) =>
        Effect.suspend(() =>
          intent
            ? context.promptLock.withPermit(
                finishTurn(intent, { state: "failed", errorMessage: cause.message }),
              )
            : Effect.void,
        ),
      ),
      Effect.onInterrupt(() =>
        context.promptLock.withPermit(
          Effect.gen(function* () {
            const turn = intent;
            if (!turn || turn.settled || context.stopped || context.generation !== turn.generation)
              return;
            const promptFiber = context.promptFiber;
            yield* cancelRequests(context);
            yield* Effect.ignore(context.runtime.cancel);
            if (promptFiber) yield* Fiber.interrupt(promptFiber);
            yield* finishTurn(turn, { state: "cancelled", stopReason: "cancelled" });
          }),
        ),
      ),
    );
  });

  const interruptTurn: Adapter["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      yield* context.promptLock
        .withPermit(
          Effect.gen(function* () {
            yield* cancelRequests(context);
            yield* context.runtime.cancel;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", cause),
          ),
        );
    });

  const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.approvals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: "This approval request is no longer pending.",
        });
      }
      const optionId =
        decision === "cancel" ? undefined : selectKimiPermissionOptionId(pending.request, decision);
      if (decision !== "cancel" && optionId === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue: "Kimi did not offer this permission choice. Select one of the available choices.",
        });
      }
      yield* Deferred.succeed(pending.response, {
        decision,
        result: {
          outcome:
            optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId },
        },
      });
    });

  const respondToUserInput: Adapter["respondToUserInput"] = (threadId, _requestId, _answers) =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      // `kimi acp` advertises no elicitation capability, so nothing ever opens a
      // structured question for the client to answer.
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "respondToUserInput",
        issue: "Kimi does not ask structured questions.",
      });
    });

  const stopSession: Adapter["stopSession"] = (threadId) =>
    withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopContext));
  const stopAll: Adapter["stopAll"] = () =>
    Effect.forEach([...sessions.values()], stopContext, { discard: true });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.void
          : Effect.logError("Could not stop a Kimi session."),
      ),
      Effect.ensuring(PubSub.shutdown(events)),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    compaction: { type: "slash-command", command: "/compact" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    stopAll,
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((context) => !context.stopped)
          .map((context) => ({ ...context.session })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns })),
    rollbackThread: (_threadId: ThreadId, _numTurns: number) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Kimi does not support conversation rewind. Start a new thread instead.",
        }),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});
