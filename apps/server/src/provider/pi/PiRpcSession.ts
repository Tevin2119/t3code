/**
 * pi RPC transport.
 *
 * `pi --mode rpc` speaks a line-delimited JSON protocol over stdin/stdout:
 * commands in, `{"type":"response"}` acknowledgements and agent events out.
 * It is not ACP, so none of the shared ACP stack applies and this module owns
 * the framing, the request/response correlation and the process lifetime.
 *
 * Framing follows the protocol's strict JSONL rule: records are split on `\n`
 * only, with a trailing `\r` stripped. A generic line reader is not usable here
 * because pi's own documentation calls out that splitting on `U+2028`/`U+2029`
 * corrupts records — those code points are legal inside JSON strings.
 *
 * @module provider/pi/PiRpcSession
 */
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const encoder = new TextEncoder();

export class PiRpcError extends Schema.TaggedError<PiRpcError>()("PiRpcError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `pi RPC ${this.operation} failed: ${this.detail}`;
  }
}

/** One decoded stdout record. `type` is always present in the protocol. */
export interface PiRpcRecord {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PiRpcResponse extends PiRpcRecord {
  readonly type: "response";
  readonly command?: string;
  readonly success?: boolean;
  readonly id?: string;
  readonly data?: unknown;
  readonly error?: string;
}

export interface PiRpcSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly shell?: boolean;
}

export interface PiRpcSessionOptions {
  readonly spawn: PiRpcSpawnInput;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** Receives bounded stderr text. Redact secrets before logging. */
  readonly onStderr?: (text: string) => Effect.Effect<void>;
}

export interface PiRpcSession {
  /** Agent events, excluding correlated command responses. */
  readonly events: Stream.Stream<PiRpcRecord>;
  /**
   * Send a command and wait for its `response` record. Commands without an
   * `id` cannot be correlated, so one is always generated.
   */
  readonly request: (command: Record<string, unknown>) => Effect.Effect<PiRpcResponse, PiRpcError>;
  /** Send a command without waiting for its acknowledgement. */
  readonly notify: (command: Record<string, unknown>) => Effect.Effect<void, PiRpcError>;
  /** Resolves when the child exits, with its status. */
  readonly exitCode: Effect.Effect<number, PiRpcError>;
}

/**
 * Split a rolling buffer into complete JSONL records. Returns the records and
 * the unterminated remainder, which the caller carries into the next chunk.
 */
export function splitJsonLines(buffer: string): {
  readonly lines: ReadonlyArray<string>;
  readonly rest: string;
} {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const lines: Array<string> = [];
  for (const part of parts) {
    // Accept CRLF input by dropping the carriage return the split left behind.
    const line = part.endsWith("\r") ? part.slice(0, -1) : part;
    if (line.trim().length > 0) lines.push(line);
  }
  return { lines, rest };
}

export function parsePiRpcRecord(line: string): PiRpcRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    return typeof record["type"] === "string" ? (record as unknown as PiRpcRecord) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start `pi --mode rpc` and wire its stdio. The child is owned by the calling
 * scope: closing it kills the process and shuts the event pubsub down.
 */
export const makePiRpcSession = Effect.fn("makePiRpcSession")(function* (
  options: PiRpcSessionOptions,
): Effect.fn.Return<PiRpcSession, PiRpcError, Scope.Scope> {
  const handle = yield* options.childProcessSpawner
    .spawn(
      ChildProcess.make(options.spawn.command, [...options.spawn.args], {
        cwd: options.spawn.cwd,
        ...(options.spawn.env ? { env: options.spawn.env } : {}),
        ...(options.spawn.shell === undefined ? {} : { shell: options.spawn.shell }),
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcError({ operation: "spawn", detail: "Could not start `pi --mode rpc`.", cause }),
      ),
    );

  const events = yield* Effect.acquireRelease(PubSub.unbounded<PiRpcRecord>(), PubSub.shutdown);
  const stdinQueue = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const pending = new Map<string, Deferred.Deferred<PiRpcResponse>>();
  let nextId = 0;

  // stdin is a Sink, so writes are funnelled through a queue that one forked
  // fiber drains for the life of the session.
  yield* Stream.fromQueue(stdinQueue).pipe(
    Stream.run(handle.stdin),
    Effect.catchCause(() => Effect.void),
    Effect.forkScoped,
  );

  const write = (payload: Record<string, unknown>) =>
    Queue.offer(stdinQueue, encoder.encode(`${JSON.stringify(payload)}\n`)).pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcError({
            operation: "write",
            detail: "Could not write to the pi RPC process.",
            cause,
          }),
      ),
      Effect.asVoid,
    );

  // One fiber owns stdout: it re-frames chunks into records, settles waiting
  // requests, and publishes everything else as an agent event.
  yield* Effect.suspend(() => {
    let buffer = "";
    return handle.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          buffer += chunk;
          const { lines, rest } = splitJsonLines(buffer);
          buffer = rest;
          for (const line of lines) {
            const record = parsePiRpcRecord(line);
            if (!record) continue;
            if (record.type === "response") {
              const response = record as PiRpcResponse;
              const id = typeof response.id === "string" ? response.id : undefined;
              const waiter = id === undefined ? undefined : pending.get(id);
              if (waiter && id !== undefined) {
                pending.delete(id);
                yield* Deferred.succeed(waiter, response);
                continue;
              }
            }
            yield* PubSub.publish(events, record);
          }
        }),
      ),
    );
  }).pipe(
    Effect.catchCause(() => Effect.void),
    // Nothing is waiting on a dead process; settle the outstanding requests so
    // callers see a transport failure rather than hanging forever.
    Effect.ensuring(
      Effect.suspend(() => {
        const waiters = [...pending.values()];
        pending.clear();
        return Effect.forEach(
          waiters,
          (waiter) =>
            Deferred.succeed(waiter, {
              type: "response",
              success: false,
              error: "The pi RPC process exited.",
            } satisfies PiRpcResponse),
          { discard: true },
        );
      }),
    ),
    Effect.forkScoped,
  );

  if (options.onStderr) {
    const onStderr = options.onStderr;
    yield* handle.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => onStderr(text)),
      Effect.catchCause(() => Effect.void),
      Effect.forkScoped,
    );
  }

  const request: PiRpcSession["request"] = (command) =>
    Effect.gen(function* () {
      const id = `t3-${++nextId}`;
      const waiter = yield* Deferred.make<PiRpcResponse>();
      pending.set(id, waiter);
      yield* write({ ...command, id }).pipe(
        Effect.tapError(() => Effect.sync(() => pending.delete(id))),
      );
      return yield* Deferred.await(waiter);
    });

  const exitCode = handle.exitCode.pipe(
    Effect.map(Number),
    Effect.mapError(
      (cause) =>
        new PiRpcError({
          operation: "exit",
          detail: "Could not read the pi RPC process exit status.",
          cause,
        }),
    ),
  );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Effect.ignore(Queue.end(stdinQueue));
      yield* Effect.ignore(handle.kill());
    }),
  );

  return {
    events: Stream.fromPubSub(events),
    request,
    notify: (command) => write(command),
    exitCode,
  };
});
