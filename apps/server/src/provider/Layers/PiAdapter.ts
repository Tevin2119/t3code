/**
 * pi RPC adapter.
 *
 * Keeps one `pi --mode rpc` process per thread and maps its JSONL event stream
 * onto orchestration events. pi is not an ACP agent, so nothing from the shared
 * ACP stack applies here — `PiRpcSession` owns the framing and this module owns
 * the translation.
 *
 * One capability gap is deliberate and visible in the shape of this file: pi
 * has no per-tool approval protocol and no sandbox (see its `docs/security.md`),
 * so tools run autonomously with the server's permissions. Nothing ever opens an
 * approval, `respondToRequest` has nothing to answer, and the thread's runtime
 * mode cannot gate execution. Callers that need gated tool use should not route
 * work to this driver.
 *
 * @module provider/Layers/PiAdapter
 */
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  TurnId,
  type PiSettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  type ToolLifecycleItemType,
  type TurnCompletedPayload,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { makePiRpcSession, type PiRpcRecord, type PiRpcSession } from "../pi/PiRpcSession.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");

type Adapter = ProviderAdapterShape<ProviderAdapterError>;

/**
 * Build the argv for a session process. `--mode rpc` implies non-interactive,
 * and the model pattern is passed fully qualified so pi resolves it directly
 * instead of fuzzy-matching the catalog.
 */
export function buildPiRpcArgs(input: {
  readonly provider: string;
  readonly model: string | undefined;
}): ReadonlyArray<string> {
  return [
    "--mode",
    "rpc",
    "--provider",
    input.provider,
    ...(input.model ? ["--model", input.model] : []),
  ];
}

/**
 * Map pi's built-in tool names onto canonical item types. pi ships `read`,
 * `bash`, `edit` and `write`; extension tools are unknown here and fall back to
 * the generic bucket.
 */
export function piItemTypeFromToolName(toolName: string): ToolLifecycleItemType {
  switch (toolName) {
    case "bash":
      return "command_execution";
    case "edit":
    case "write":
      return "file_change";
    default:
      return "dynamic_tool_call";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface TurnIntent {
  readonly turnId: TurnId;
  readonly generation: number;
  settled: boolean;
  /** Settles when pi reports the run fully settled, or the process dies. */
  readonly done: Deferred.Deferred<{ readonly cancelled: boolean; readonly error?: string }>;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly scope: Scope.Closeable;
  readonly rpc: PiRpcSession;
  readonly promptLock: Semaphore.Semaphore;
  readonly stopLock: Semaphore.Semaphore;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  activeIntent: TurnIntent | undefined;
  generation: number;
  stopped: boolean;
  closed: boolean;
  disconnected: boolean;
}

export interface PiAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  settings: PiSettings,
  options: PiAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ownerScope = yield* Effect.scope;
  const environment = options.environment ?? process.env;
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
          detail: "Could not create a pi event ID.",
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

  const stopContext = (context: SessionContext) =>
    context.stopLock
      .withPermit(
        Effect.gen(function* () {
          if (context.closed) return;
          context.stopped = true;
          const intent = context.activeIntent;
          if (intent && !intent.settled) {
            yield* Deferred.succeed(intent.done, {
              cancelled: true,
              ...(context.disconnected ? { error: "The pi process stopped." } : {}),
            });
          }
          yield* Scope.close(context.scope, Exit.void);
          context.closed = true;
          if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
          yield* emit({
            type: "session.exited",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            payload: {
              exitKind: context.disconnected ? "error" : "graceful",
              ...(context.disconnected ? { reason: "The pi process stopped." } : {}),
            },
          });
        }),
      )
      .pipe(Effect.uninterruptible);

  /**
   * Translate one pi record. Streaming deltas become content events, tool
   * execution becomes item events, and the run-settled records release the
   * waiting `sendTurn`.
   */
  const handleRecord = Effect.fn("PiAdapter.handleRecord")(function* (
    context: SessionContext,
    record: PiRpcRecord,
  ) {
    if (context.stopped) return;
    const turnId = context.activeTurnId;
    switch (record.type) {
      case "message_update": {
        const delta = asRecord(record["assistantMessageEvent"]);
        const deltaType = asString(delta?.["type"]);
        const text = asString(delta?.["delta"]);
        if (!delta || !deltaType || text === undefined) return;
        if (deltaType !== "text_delta" && deltaType !== "thinking_delta") return;
        yield* emit({
          type: "content.delta",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          payload: {
            streamKind: deltaType === "thinking_delta" ? "reasoning_text" : "assistant_text",
            delta: text,
          },
          raw: { source: "pi.rpc.event", method: "message_update", payload: record },
        });
        return;
      }
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end": {
        const toolCallId = asString(record["toolCallId"]);
        if (!toolCallId) return;
        const toolName = asString(record["toolName"]) ?? "tool";
        const failed = record["isError"] === true;
        const completed = record.type === "tool_execution_end";
        yield* emit({
          type: completed ? "item.completed" : "item.updated",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          itemId: RuntimeItemId.make(toolCallId),
          payload: {
            itemType: piItemTypeFromToolName(toolName),
            status: completed ? (failed ? "failed" : "completed") : "inProgress",
            title: toolName,
          },
          raw: { source: "pi.rpc.event", method: record.type, payload: record },
        });
        return;
      }
      case "agent_settled": {
        const intent = context.activeIntent;
        if (intent && !intent.settled) {
          yield* Deferred.succeed(intent.done, { cancelled: false });
        }
        return;
      }
      case "agent_end": {
        // A run that will retry is not the end of the turn; wait for
        // `agent_settled` in that case.
        if (record["willRetry"] === true) return;
        return;
      }
      default:
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
            issue: "Enable pi in provider settings before starting a thread.",
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
            issue: "The pi provider instance does not match the requested session.",
          });
        }
        const cwd = input.cwd?.trim();
        if (!cwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The session requires a workspace directory.",
          });
        }
        const previous = sessions.get(input.threadId);
        if (previous) yield* stopContext(previous);

        const sessionScope = yield* Scope.make("sequential");
        let transferred = false;
        yield* Effect.addFinalizer(() => {
          if (transferred) return Effect.void;
          sessions.delete(input.threadId);
          return Scope.close(sessionScope, Exit.void);
        });

        return yield* Effect.gen(function* () {
          const command = settings.binaryPath || "pi";
          const model = input.modelSelection?.model?.trim() || undefined;
          const args = buildPiRpcArgs({
            provider: settings.provider.trim() || "kimi-coding",
            model,
          });
          const spawnCommand = yield* resolveSpawnCommand(command, args, {
            env: environment,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/start",
                  detail: "Could not resolve the pi CLI.",
                  cause,
                }),
            ),
          );
          const rpc = yield* makePiRpcSession({
            childProcessSpawner: spawner,
            spawn: {
              command: spawnCommand.command,
              args: spawnCommand.args,
              cwd,
              env: environment,
              ...(spawnCommand.shell === undefined ? {} : { shell: spawnCommand.shell }),
            },
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/start",
                  detail: cause.detail,
                  cause,
                }),
            ),
          );

          const createdAt = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            cwd,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(model ? { model } : {}),
            createdAt,
            updatedAt: createdAt,
          };
          const context: SessionContext = {
            threadId: input.threadId,
            cwd,
            scope: sessionScope,
            rpc,
            promptLock: yield* Semaphore.make(1),
            stopLock: yield* Semaphore.make(1),
            turns: [],
            session,
            activeTurnId: undefined,
            activeIntent: undefined,
            generation: 0,
            stopped: false,
            closed: false,
            disconnected: false,
          };
          sessions.set(input.threadId, context);

          yield* Stream.runForEach(rpc.events, (record) => handleRecord(context, record)).pipe(
            Effect.catchCause(() => Effect.logError("Could not process a pi runtime event.")),
            Effect.forkIn(sessionScope),
          );
          // The process dying mid-turn has to surface as a closed session
          // rather than a turn that never settles.
          yield* rpc.exitCode.pipe(
            Effect.flatMap(() =>
              Effect.suspend(() => {
                context.disconnected = true;
                return stopContext(context);
              }),
            ),
            Effect.catchCause(() => Effect.void),
            Effect.forkIn(ownerScope),
          );

          yield* emit({
            type: "session.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {},
          });
          yield* emit({
            type: "session.state.changed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "pi RPC session ready" },
          });
          yield* emit({
            type: "thread.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {},
          });
          transferred = true;
          return session;
        }).pipe(Effect.provideService(Scope.Scope, sessionScope));
      }).pipe(Effect.scoped),
    );

  const sendTurn: Adapter["sendTurn"] = Effect.fn("PiAdapter.sendTurn")(function* (input) {
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
        issue: "pi turns need a prompt.",
      });
    }

    const finishTurn = (turn: TurnIntent, payload: TurnCompletedPayload) =>
      Effect.gen(function* () {
        if (turn.settled || context.generation !== turn.generation) return;
        turn.settled = true;
        context.activeTurnId = undefined;
        context.activeIntent = undefined;
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

    const turn = yield* context.promptLock.withPermit(
      Effect.gen(function* () {
        yield* requireSession(input.threadId);
        const model = input.modelSelection?.model ?? context.session.model;
        const turnId = TurnId.make(yield* randomId);
        const intent: TurnIntent = {
          turnId,
          generation: ++context.generation,
          settled: false,
          done: yield* Deferred.make<{ cancelled: boolean; error?: string }>(),
        };
        context.activeTurnId = turnId;
        context.activeIntent = intent;
        yield* emit({
          type: "turn.started",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: model ? { model } : {},
        });
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          ...(model ? { model } : {}),
          updatedAt: yield* nowIso,
        };
        // `prompt` is acknowledged as accepted; the work itself streams back as
        // events and ends with `agent_settled`.
        const response = yield* context.rpc.request({ type: "prompt", message: text }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: cause.detail,
                cause,
              }),
          ),
        );
        if (response.success === false) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: asString(response.error) ?? "pi rejected the prompt.",
          });
        }
        return intent;
      }),
    );

    const outcome = yield* Deferred.await(turn.done);
    if (context.stopped && !outcome.cancelled) {
      return yield* new ProviderAdapterSessionClosedError({
        provider: PROVIDER,
        threadId: input.threadId,
      });
    }
    const record = context.turns.find((entry) => entry.id === turn.turnId);
    if (record) record.items.push(outcome);
    else context.turns.push({ id: turn.turnId, items: [outcome] });
    yield* context.promptLock.withPermit(
      finishTurn(turn, {
        state: outcome.error ? "failed" : outcome.cancelled ? "cancelled" : "completed",
        ...(outcome.cancelled && !outcome.error ? { stopReason: "cancelled" as const } : {}),
        ...(outcome.error ? { errorMessage: outcome.error } : {}),
      }),
    );
    return { threadId: input.threadId, turnId: turn.turnId };
  });

  const interruptTurn: Adapter["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      yield* context.rpc.request({ type: "abort" }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "abort",
              detail: cause.detail,
              cause,
            }),
        ),
      );
      const intent = context.activeIntent;
      if (intent && !intent.settled) {
        yield* Deferred.succeed(intent.done, { cancelled: true });
      }
    });

  const respondToRequest: Adapter["respondToRequest"] = (threadId) =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      // pi runs tools without asking, so no approval is ever opened for one.
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "respondToRequest",
        issue: "pi does not request tool approval.",
      });
    });

  const respondToUserInput: Adapter["respondToUserInput"] = (threadId) =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "respondToUserInput",
        issue: "pi does not ask structured questions.",
      });
    });

  const stopSession: Adapter["stopSession"] = (threadId) =>
    withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopContext));
  const stopAll: Adapter["stopAll"] = () =>
    Effect.forEach([...sessions.values()], stopContext, { discard: true });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.void : Effect.logError("Could not stop a pi session."),
      ),
      Effect.ensuring(PubSub.shutdown(events)),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported", supportsConversationRollback: false },
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
          issue: "pi does not support conversation rewind. Start a new thread instead.",
        }),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});
