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
import type { ModelSelection } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
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
import * as DeliveryThreadSession from "../../delivery/DeliveryThreadSession.ts";
import { makePiRpcSession, type PiRpcRecord, type PiRpcSession } from "../pi/PiRpcSession.ts";
import { PI_THINKING_LEVELS } from "./PiProvider.ts";

/** What a person chose as Reasoning. Undefined leaves pi on its own level. */
export const chosenPiThinkingLevel = (
  selection: ModelSelection | undefined,
): string | undefined => {
  const chosen = selection ? getModelSelectionStringOptionValue(selection, "thinking") : undefined;
  return chosen && (PI_THINKING_LEVELS as ReadonlyArray<string>).includes(chosen)
    ? chosen
    : undefined;
};

/**
 * What `get_session_stats` says, as the usage of a thread. pi counts what the context holds
 * apart from what the session has used in all.
 */
export function piUsageFromStats(data: unknown):
  | {
      readonly usedTokens: number;
      readonly maxTokens?: number;
      readonly totalProcessedTokens?: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly cachedInputTokens?: number;
    }
  | undefined {
  const stats = asRecord(data);
  const tokens = asRecord(stats?.["tokens"]);
  const context = asRecord(stats?.["contextUsage"]);
  const whole = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
  const used = whole(context?.["tokens"]) ?? whole(tokens?.["total"]);
  if (used === undefined) return undefined;
  const size = whole(context?.["contextWindow"]);
  const total = whole(tokens?.["total"]);
  const input = whole(tokens?.["input"]);
  const output = whole(tokens?.["output"]);
  const cached = whole(tokens?.["cacheRead"]);
  return {
    usedTokens: used,
    ...(size ? { maxTokens: size } : {}),
    ...(total === undefined ? {} : { totalProcessedTokens: total }),
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
  };
}

/** Why a turn of pi failed, read from the record that says so, or undefined. */
export function piFailureFromRecord(record: PiRpcRecord): string | undefined {
  if (record.type === "auto_retry_end" && record["success"] === false) {
    return asString(record["finalError"]) ?? "pi gave up after retrying.";
  }
  if (record.type === "message_end") {
    const message = asRecord(record["message"]);
    if (message?.["role"] === "assistant" && message["stopReason"] === "error") {
      return asString(message["errorMessage"]) ?? "The model call failed.";
    }
  }
  return undefined;
}
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { PI_RUNTIME_MODES, runtimeModeProblem } from "../runtimeModeSupport.ts";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import {
  decodePiResumeCursor,
  piCursorFrom,
  piRestoredProblem,
  piRestorePlan,
  piSessionStateFrom,
} from "../pi/piSession.ts";

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
  /** What is chosen as Reasoning. Left out, pi decides for itself. */
  readonly thinking?: string | undefined;
  /** For a thread bound to a team: `--append-system-prompt` and `--skill` with their paths. */
  readonly teamArgs?: ReadonlyArray<string>;
  /** The file of the session to take up again. Left out, pi starts a session that is new. */
  readonly sessionFile?: string | undefined;
}): ReadonlyArray<string> {
  return [
    "--mode",
    "rpc",
    "--provider",
    input.provider,
    ...(input.model ? ["--model", input.model] : []),
    ...(input.thinking ? ["--thinking", input.thinking] : []),
    ...(input.sessionFile ? ["--session", input.sessionFile] : []),
    ...(input.teamArgs ?? []),
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
  /** The level last asked of pi, so that it is asked again only when it changes. */
  thinkingAsked: string | undefined;
  /** Why the model call of the turn that is running failed, when it did. */
  turnFailure: string | undefined;
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
  const fileSystem = yield* FileSystem.FileSystem;
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
  /**
   * Asks pi for the level a person chose, when it is another than the one asked for last, and
   * says what pi then runs on. pi lowers a level the model does not take without saying so,
   * so what it reports is what is shown.
   */
  const syncReasoning = Effect.fn("PiAdapter.syncReasoning")(function* (
    context: SessionContext,
    chosen: string | undefined,
  ) {
    if (chosen !== undefined && chosen !== context.thinkingAsked) {
      const set = yield* context.rpc
        .request({ type: "set_thinking_level", level: chosen })
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (set?.success !== false) context.thinkingAsked = chosen;
    }
    const state = yield* context.rpc
      .request({ type: "get_state" })
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    const effective = asString(asRecord(state?.data)?.["thinkingLevel"]);
    yield* emit({
      type: "session.configured",
      ...(yield* stamp),
      provider: PROVIDER,
      threadId: context.threadId,
      payload: {
        config: {
          reasoning: {
            option: "thinking",
            chosen: chosen ?? null,
            effective: effective ?? null,
            applied: chosen !== undefined && effective === chosen,
          },
        },
      },
    });
    if (chosen !== undefined && effective !== undefined && effective !== chosen) {
      yield* emit({
        type: "runtime.warning",
        ...(yield* stamp),
        provider: PROVIDER,
        threadId: context.threadId,
        payload: {
          message: `The reasoning level "${chosen}" was asked for and pi runs on "${effective}", which is what this model takes.`,
          detail: { chosen, effective },
        },
      });
    }
  });

  /** Says what the session holds of its context window and what it has used, as pi counts it. */
  const reportUsage = Effect.fn("PiAdapter.reportUsage")(function* (
    context: SessionContext,
    turnId: TurnId | undefined,
  ) {
    const stats = yield* context.rpc
      .request({ type: "get_session_stats" })
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    const usage = stats?.success === false ? undefined : piUsageFromStats(stats?.data);
    if (!usage) return;
    yield* emit({
      type: "thread.token-usage.updated",
      ...(yield* stamp),
      provider: PROVIDER,
      threadId: context.threadId,
      ...(turnId ? { turnId } : {}),
      payload: { usage },
      raw: { source: "pi.rpc.event", method: "get_session_stats", payload: stats?.data },
    });
  });

  const handleRecord = Effect.fn("PiAdapter.handleRecord")(function* (
    context: SessionContext,
    record: PiRpcRecord,
  ) {
    if (context.stopped) return;
    const turnId = context.activeTurnId;
    // A model call that failed is a turn that failed, though pi settles it like any other.
    const failure = piFailureFromRecord(record);
    if (failure) context.turnFailure = failure;
    else if (record.type === "auto_retry_end" && record["success"] === true) {
      context.turnFailure = undefined;
    }
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
          yield* Deferred.succeed(intent.done, {
            cancelled: false,
            ...(context.turnFailure ? { error: context.turnFailure } : {}),
          });
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
        // Never run as another mode: a mode this provider cannot honour is refused.
        const modeProblem = runtimeModeProblem(PI_RUNTIME_MODES, input.runtimeMode);
        if (modeProblem) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: modeProblem,
          });
        }
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
        // The session of the thread is taken up again, or the thread is not started.
        const cursor = decodePiResumeCursor(input.resumeCursor);
        if (
          input.resumeCursor !== undefined &&
          input.resumeCursor !== null &&
          Option.isNone(cursor)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue:
              "The saved pi session of this thread cannot be read, so its conversation cannot be taken up. Nothing was started. Start a new thread.",
          });
        }
        const had = Option.getOrUndefined(cursor);
        const there = had
          ? yield* fileSystem.exists(had.sessionFile).pipe(Effect.orElseSucceed(() => false))
          : false;
        const plan = piRestorePlan(had, () => there);
        if ("problem" in plan) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: plan.problem,
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
          const team = DeliveryThreadSession.deliveryPiLaunch(input.threadId);
          // With no level chosen nothing is passed, and pi runs on its own.
          const thinking = chosenPiThinkingLevel(input.modelSelection);
          const args = buildPiRpcArgs({
            provider: settings.provider.trim() || "kimi-coding",
            model,
            thinking,
            teamArgs: team.args,
            ...(plan.restore && had ? { sessionFile: had.sessionFile } : {}),
          });
          // The team's tools read who they serve from the environment pi runs in.
          const spawnEnvironment = { ...environment, ...team.env };
          const spawnCommand = yield* resolveSpawnCommand(command, args, {
            env: spawnEnvironment,
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
              env: spawnEnvironment,
              ...(spawnCommand.shell === undefined ? {} : { shell: spawnCommand.shell }),
            },
            // What pi writes beside its records is read, so that its pipe never fills.
            onStderr: (text) => Effect.logDebug("pi stderr", { text: text.slice(0, 2000) }),
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

          const opened = piSessionStateFrom(
            (yield* rpc
              .request({ type: "get_state" })
              .pipe(Effect.catch(() => Effect.succeed(undefined))))?.data,
          );
          if (plan.restore && had) {
            const problem = piRestoredProblem(had, opened);
            if (problem) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: problem,
              });
            }
          }
          const resumeCursor = piCursorFrom(opened);
          const createdAt = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            cwd,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(model ? { model } : {}),
            ...(resumeCursor ? { resumeCursor } : {}),
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
            thinkingAsked: thinking,
            turnFailure: undefined,
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
            type: "session.configured",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {
              config: {
                session: {
                  // Said by pi itself, after it was started.
                  id: opened.sessionId ?? null,
                  messages: opened.messages ?? null,
                  takenUpAgain: plan.restore,
                  ...(plan.restore && had ? { heldBefore: had.messages } : {}),
                },
                passed: {
                  arguments: args.map((word) =>
                    word === had?.sessionFile ? "<the file of the session>" : word,
                  ),
                },
              },
            },
          });
          yield* syncReasoning(context, thinking);
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
        context.turnFailure = undefined;
        // A level chosen since the last turn is asked of pi before the prompt.
        yield* syncReasoning(context, chosenPiThinkingLevel(input.modelSelection));
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
    if (!context.stopped) yield* reportUsage(context, turn.turnId);
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
    const held = context.stopped
      ? undefined
      : piCursorFrom(
          piSessionStateFrom(
            (yield* context.rpc
              .request({ type: "get_state" })
              .pipe(Effect.catch(() => Effect.succeed(undefined))))?.data,
          ),
        );
    if (held) context.session = { ...context.session, resumeCursor: held };
    return {
      threadId: input.threadId,
      turnId: turn.turnId,
      ...(held ? { resumeCursor: held } : {}),
    };
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
