/**
 * Auth controller for CLIs that sign in outside the browser.
 *
 * `AntigravityAuth` drives an ACP agent that hands T3 Code an OAuth
 * authorization URL and expects the redirect back. The CLI harnesses do not
 * work that way: `kimi login` runs a device-code exchange in its own process,
 * prints a verification URL plus a short code, and polls until the user
 * approves — nothing ever redirects to us. Other CLIs (pi) have no headless
 * sign-in entry point at all and can only be re-checked.
 *
 * Both shapes collapse into one controller: a flow either runs a login child
 * process and then re-reads the CLI's credential state, or it only re-reads it.
 * `complete` is therefore always a failure here — there is no redirect URL for
 * a client to paste, and saying so is better than accepting one and ignoring it.
 *
 * @module provider/CliAuth
 */
import {
  ProviderSetupError,
  type ProviderAuthState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { ProviderAuthController } from "./Services/ProviderAuthService.ts";

/** Verification target a device-code CLI prints on its way to waiting. */
export interface CliAuthChallenge {
  readonly verificationUrl: string;
  readonly verificationCode: string | undefined;
}

export interface CliAuthLogin {
  /**
   * Fully resolved argv for the CLI's sign-in entry point. Built by the caller
   * so binary-path resolution stays with the driver that owns the setting.
   */
  readonly command: Effect.Effect<ChildProcess.Command, ProviderSetupError>;
  /**
   * Read a verification URL out of whatever the login process has printed so
   * far. Called with the accumulated stdout+stderr text, and only until it
   * first returns a challenge.
   */
  readonly parseChallenge: (output: string) => CliAuthChallenge | undefined;
  /** How long the printed code stays valid. Defaults to 15 minutes. */
  readonly timeoutMs?: number | undefined;
}

export interface CliAuthOptions {
  readonly instanceId: ProviderInstanceId;
  /** Provider name, used verbatim in user-visible status text. */
  readonly providerName: string;
  /** Absent when the CLI has no headless sign-in and can only be re-checked. */
  readonly login?: CliAuthLogin | undefined;
  /** Re-read the CLI's credential state once a flow has done its work. */
  readonly verify: Effect.Effect<boolean>;
  /** Shown when `verify` reports no usable credentials. */
  readonly signInHint: string;
  /** Absent when the CLI cannot sign out without a terminal. */
  readonly logout?:
    | ((
        stopSessions: Effect.Effect<void, ProviderSetupError>,
      ) => Effect.Effect<void, ProviderSetupError>)
    | undefined;
  /** Shown when `logout` is absent and a client asks to sign out. */
  readonly signOutHint?: string | undefined;
  /** Runs after a flow settles so the provider snapshot picks the change up. */
  readonly onSettled?: Effect.Effect<void> | undefined;
}

const DEFAULT_LOGIN_TIMEOUT_MS = 900_000;
const VERIFY_TIMEOUT_MS = 60_000;
/** Bounds the buffer the challenge parser scans; codes print in the first lines. */
const MAX_CHALLENGE_SCAN_BYTES = 16_384;

interface AuthSnapshot {
  readonly ownerSessionId: string | null;
  readonly state: ProviderAuthState;
}

interface AuthFlow {
  readonly id: string;
  readonly ownerSessionId: string;
  state: ProviderAuthState;
  fiber: Fiber.Fiber<void> | undefined;
}

/**
 * Hide another client's flow identifiers. A second client may see that sign-in
 * is busy, but never a code it could redeem or a flow id it could cancel.
 */
function visibleSnapshot(snapshot: AuthSnapshot, ownerSessionId: string): ProviderAuthState {
  if (snapshot.ownerSessionId === null || snapshot.ownerSessionId === ownerSessionId) {
    return snapshot.state;
  }
  const busy = ["starting", "waiting", "verifying"].includes(snapshot.state.phase);
  return {
    ...snapshot.state,
    flowId: null,
    authorizationUrl: null,
    verificationCode: null,
    expiresAt: null,
    ...(busy ? { message: "Sign-in is in progress in another client." } : {}),
  };
}

/**
 * Run the CLI's login process, publishing the verification challenge as soon as
 * it prints one. Succeeds when the process exits cleanly; the caller re-reads
 * credential state afterwards rather than trusting the exit code alone.
 */
const runLoginProcess = Effect.fn("CliAuth.runLoginProcess")(function* (
  instanceId: ProviderInstanceId,
  login: CliAuthLogin,
  providerName: string,
  onChallenge: (challenge: CliAuthChallenge) => Effect.Effect<void>,
): Effect.fn.Return<
  void,
  ProviderSetupError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const fail = (detail: string) =>
    new ProviderSetupError({ instanceId, operation: "start", detail });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = yield* login.command;
  const handle = yield* spawner
    .spawn(command)
    .pipe(Effect.mapError(() => fail(`Could not start ${providerName} sign-in.`)));

  // The CLI writes the challenge to stderr, and other CLIs write it to stdout,
  // so both feed one buffer. Parsing stops at the first hit to keep the tail of
  // a long-running poll out of memory.
  let buffer = "";
  let found = false;
  const scan = (text: string) =>
    Effect.suspend(() => {
      if (found) return Effect.void;
      buffer = `${buffer}${text}`.slice(-MAX_CHALLENGE_SCAN_BYTES);
      const challenge = login.parseChallenge(buffer);
      if (!challenge) return Effect.void;
      found = true;
      buffer = "";
      return onChallenge(challenge);
    });

  yield* Effect.forEach(
    [handle.stdout, handle.stderr],
    (stream) =>
      stream.pipe(
        Stream.decodeText(),
        Stream.runForEach(scan),
        Effect.ignoreCause,
        Effect.forkScoped,
      ),
    { discard: true },
  );

  const exitCode = yield* handle.exitCode.pipe(
    Effect.map(Number),
    Effect.mapError(() => fail(`Could not read the ${providerName} sign-in result.`)),
  );
  if (exitCode !== 0) {
    return yield* fail(`${providerName} sign-in did not complete. Start sign-in again.`);
  }
});

/** Owns one instance's CLI sign-in state and serializes every flow against it. */
export const makeCliAuth = Effect.fn("makeCliAuth")(function* (
  options: CliAuthOptions,
): Effect.fn.Return<
  ProviderAuthController,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const instanceScope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const closed = yield* Deferred.make<void>();
  const loginTimeoutMs = options.login?.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const flowTimeoutMs = options.login ? loginTimeoutMs : VERIFY_TIMEOUT_MS;

  const emptyState: ProviderAuthState = {
    instanceId: options.instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    verificationCode: null,
    expiresAt: null,
    message: null,
  };
  const snapshot = yield* SubscriptionRef.make<AuthSnapshot>({
    ownerSessionId: null,
    state: emptyState,
  });
  let activeFlow: AuthFlow | undefined;
  let operation: "idle" | "auth" | "logout" | "closed" = "idle";

  const setupError = (name: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation: name, detail });
  const publishFlow = (flow: AuthFlow, state: ProviderAuthState) => {
    flow.state = state;
    return SubscriptionRef.set(snapshot, { ownerSessionId: flow.ownerSessionId, state });
  };
  const settled = options.onSettled ?? Effect.void;

  const receiveChallenge = (flow: AuthFlow, challenge: CliAuthChallenge) =>
    lock.withPermits(1)(
      Effect.suspend(() => {
        if (activeFlow !== flow || operation !== "auth") return Effect.void;
        return publishFlow(flow, {
          ...flow.state,
          phase: "waiting",
          authorizationUrl: challenge.verificationUrl,
          verificationCode: challenge.verificationCode ?? null,
          message: challenge.verificationCode
            ? `Open the sign-in page and enter code ${challenge.verificationCode}.`
            : "Open the sign-in page to finish signing in.",
        });
      }),
    );

  /**
   * Publish the terminal phase. A clean login process that leaves the CLI
   * without credentials still counts as a failure — the exit code alone says
   * nothing about whether the user actually approved the request.
   */
  /** Prefer the failure's own safe detail; fall back to a generic line. */
  const failureMessage = (cause: Cause.Cause<ProviderSetupError>, fallback: string): string => {
    const error = Cause.findErrorOption(cause);
    return Option.isSome(error) && error.value.detail.trim().length > 0
      ? error.value.detail
      : fallback;
  };

  const finishFlow = (flow: AuthFlow, result: Exit.Exit<boolean, ProviderSetupError>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (activeFlow !== flow) return;
        activeFlow = undefined;
        operation = "idle";
        const authenticated = Exit.isSuccess(result) && result.value;
        yield* publishFlow(flow, {
          ...flow.state,
          phase: authenticated ? "succeeded" : "failed",
          authorizationUrl: null,
          verificationCode: null,
          expiresAt: null,
          message: authenticated
            ? `Signed in to ${options.providerName}.`
            : Exit.isFailure(result)
              ? failureMessage(result.cause, `${options.providerName} sign-in failed.`)
              : options.signInHint,
        });
      }),
    );

  const runFlow = (flow: AuthFlow, stopSessions: Effect.Effect<void, ProviderSetupError>) =>
    Effect.gen(function* () {
      yield* stopSessions;
      if (options.login) {
        yield* runLoginProcess(
          options.instanceId,
          options.login,
          options.providerName,
          (challenge) => receiveChallenge(flow, challenge),
        ).pipe(
          Effect.scoped,
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
      }
      yield* lock.withPermits(1)(
        Effect.suspend(() =>
          activeFlow === flow
            ? publishFlow(flow, {
                ...flow.state,
                phase: "verifying",
                authorizationUrl: null,
                verificationCode: null,
                message: `Checking ${options.providerName} credentials.`,
              })
            : Effect.void,
        ),
      );
      return yield* options.verify;
    }).pipe(
      Effect.timeoutOrElse({
        duration: flowTimeoutMs,
        orElse: () =>
          Effect.fail(
            setupError("start", `${options.providerName} sign-in expired. Start sign-in again.`),
          ),
      }),
      Effect.exit,
      Effect.flatMap((result) => finishFlow(flow, result)),
      Effect.ensuring(settled),
    );

  const controller: ProviderAuthController = {
    start: (ownerSessionId, stopSessions = Effect.void) =>
      lock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (activeFlow?.ownerSessionId === ownerSessionId && operation === "auth") {
              return activeFlow.state;
            }
            if (operation !== "idle") {
              return yield* setupError(
                "start",
                `${options.providerName} setup is already in progress.`,
              );
            }
            const flowId = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(() =>
                setupError("start", `Could not start ${options.providerName} sign-in. Try again.`),
              ),
            );
            const expiresAtMillis = (yield* Clock.currentTimeMillis) + flowTimeoutMs;
            const state: ProviderAuthState = {
              ...emptyState,
              phase: "starting",
              flowId,
              expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtMillis)),
              message: options.login
                ? `Starting ${options.providerName} sign-in.`
                : `Checking ${options.providerName} credentials.`,
            };
            const flow: AuthFlow = { id: flowId, ownerSessionId, state, fiber: undefined };
            activeFlow = flow;
            operation = "auth";
            yield* publishFlow(flow, state);
            flow.fiber = yield* runFlow(flow, stopSessions).pipe(
              Effect.interruptible,
              Effect.forkIn(instanceScope),
            );
            return state;
          }),
        ),
      ),
    // Device-code and credential-check flows settle inside the CLI, so there is
    // never a redirect for a client to hand back.
    complete: (_ownerSessionId, _input) =>
      Effect.fail(
        setupError(
          "complete",
          `${options.providerName} sign-in finishes in the browser. There is no redirect URL to paste.`,
        ),
      ),
    cancel: Effect.fn("CliAuth.cancel")(function* (ownerSessionId, flowId) {
      const flow = yield* lock.withPermits(1)(
        Effect.suspend(() => {
          const current = activeFlow;
          if (!current || current.id !== flowId || current.ownerSessionId !== ownerSessionId) {
            return Effect.fail(
              setupError("cancel", "This sign-in is no longer active in this client."),
            );
          }
          activeFlow = undefined;
          operation = "idle";
          return publishFlow(current, {
            ...current.state,
            phase: "cancelled",
            authorizationUrl: null,
            verificationCode: null,
            expiresAt: null,
            message: `${options.providerName} sign-in was cancelled.`,
          }).pipe(Effect.as(current));
        }),
      );
      // Interrupting the flow fiber closes its scope, which kills the login
      // child process the CLI left polling.
      if (flow.fiber) yield* Fiber.interrupt(flow.fiber);
      return flow.state;
    }),
    logout: Effect.fn("CliAuth.logout")(function* (stopSessions) {
      const run = options.logout;
      if (!run) {
        return yield* setupError(
          "logout",
          options.signOutHint ?? `${options.providerName} cannot sign out from T3 Code.`,
        );
      }
      const cancelled = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (operation === "logout" || operation === "closed") {
            return yield* setupError(
              "logout",
              `${options.providerName} setup is already stopping.`,
            );
          }
          operation = "logout";
          const current = activeFlow;
          activeFlow = undefined;
          if (current) {
            yield* publishFlow(current, {
              ...current.state,
              phase: "cancelled",
              authorizationUrl: null,
              verificationCode: null,
              expiresAt: null,
              message: `${options.providerName} sign-in was cancelled by sign-out.`,
            });
          }
          return current;
        }),
      );
      if (cancelled?.fiber) yield* Fiber.interrupt(cancelled.fiber);
      // Run detached so a client that disconnects mid-request cannot leave the
      // controller pinned in the `logout` state.
      const worker = yield* run(stopSessions).pipe(
        Effect.timeoutOrElse({
          duration: "90 seconds",
          orElse: () =>
            Effect.fail(setupError("logout", `${options.providerName} sign-out timed out.`)),
        }),
        Effect.ensuring(settled),
        Effect.forkIn(instanceScope),
      );
      const result = yield* Fiber.await(worker);
      // The CLI owns its credential store, so a clean sign-out is the verdict.
      // `onSettled` re-probes; a store that still reports a credential surfaces
      // in the provider snapshot rather than as a sign-out failure here.
      const succeeded = Exit.isSuccess(result);
      const failed = succeeded
        ? ""
        : failureMessage(result.cause, `${options.providerName} sign-out failed. Try again.`);
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          operation = "idle";
          yield* SubscriptionRef.set(snapshot, {
            ownerSessionId: null,
            state: {
              ...emptyState,
              phase: succeeded ? "idle" : "failed",
              message: succeeded ? `Signed out of ${options.providerName}.` : failed,
            },
          });
        }),
      );
      if (!succeeded) {
        return yield* setupError("logout", failed);
      }
      return yield* SubscriptionRef.get(snapshot).pipe(Effect.map((value) => value.state));
    }),
    subscribe: (ownerSessionId) =>
      SubscriptionRef.changes(snapshot).pipe(
        Stream.map((value) => visibleSnapshot(value, ownerSessionId)),
        Stream.interruptWhen(Deferred.await(closed)),
      ),
    ...(options.logout
      ? {
          isLogoutPrompt: (text: string, hasAttachments: boolean) =>
            !hasAttachments && text.trim() === "/logout",
        }
      : {}),
  };

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      operation = "closed";
      const flow = activeFlow;
      activeFlow = undefined;
      if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
      yield* Deferred.succeed(closed, undefined);
    }),
  );

  return controller;
});
