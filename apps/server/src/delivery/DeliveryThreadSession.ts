import type { DeliveryError, ThreadId } from "@t3tools/contracts";
import * as DeliveryThreadSessions from "@t3tools/provider-core/server/deliveryThreadSession";
import * as Effect from "effect/Effect";

import {
  type EffectivePatch,
  type EffectiveReport,
  sameReport,
  withPatch,
} from "./DeliveryEffective.ts";

// The thread-keyed record adapters read lives in provider-core, so provider
// packages can read it too. It is re-exported here for the delivery service.
export {
  clearDeliveryThreadSession,
  deliveryAcpServers,
  deliveryCodexArgs,
  deliveryInstructions,
  deliveryPiLaunch,
  deliveryStdioServers,
  readDeliveryThreadSession,
  setDeliveryThreadSession,
  tomlString,
  type DeliveryThreadSession,
  type DeliveryToolServer,
} from "@t3tools/provider-core/server/deliveryThreadSession";

export function clearAllDeliveryThreadSessions(): void {
  DeliveryThreadSessions.clearDeliveryThreadSessions();
  effectiveByThread.clear();
}

type Preparer = (
  threadId: ThreadId,
  actual: { readonly driver: string; readonly cwd: string | undefined },
) => Effect.Effect<boolean, DeliveryError>;
let preparer: Preparer | undefined;

/** Set by DeliveryService when it starts, so ProviderService needs no layer dependency on it. */
export function registerDeliveryPreparer(next: Preparer | undefined): void {
  preparer = next;
}

/**
 * Loads a bound thread's team setup before its harness starts. `false` for
 * an unbound thread or when no delivery service is running. Fails when the
 * thread is bound and its setup cannot be fetched: a bound thread must not
 * start as an ordinary one.
 */
export function prepareDeliveryThread(
  threadId: ThreadId,
  actual: { readonly driver: string; readonly cwd: string | undefined },
): Effect.Effect<boolean, DeliveryError> {
  return preparer ? preparer(threadId, actual) : Effect.succeed(false);
}

type Reporter = (threadId: ThreadId, report: EffectiveReport) => Effect.Effect<void>;
let reporter: Reporter | undefined;

/** Set by DeliveryService, which sends each report to the engine's record of the session. */
export function registerDeliveryReporter(next: Reporter | undefined): void {
  reporter = next;
}

const EMPTY_REPORT: EffectiveReport = {
  reason: "",
  requested: {},
  passed: {},
  confirmed: {},
  confirmedBy: {},
  notApplied: [],
};
// What is known of the session a thread is starting or running. An adapter
// reports while the session is still starting, so what it says is kept until
// the start itself is reported.
const effectiveByThread = new Map<ThreadId, { started: boolean; report: EffectiveReport }>();

/** A session of this thread is about to start: what was known of the last one is dropped. */
export function beginDeliveryEffective(threadId: ThreadId): void {
  if (DeliveryThreadSessions.readDeliveryThreadSession(threadId)) {
    effectiveByThread.set(threadId, { started: false, report: EMPTY_REPORT });
  } else {
    effectiveByThread.delete(threadId);
  }
}

/** The session of a team thread has started with what the person chose. */
export function reportDeliveryStart(
  threadId: ThreadId,
  start: Pick<EffectiveReport, "reason" | "requested"> & EffectivePatch,
): Effect.Effect<void> {
  const known = effectiveByThread.get(threadId);
  if (!known || !reporter) return Effect.void;
  const report = withPatch(
    withPatch({ ...known.report, reason: start.reason, requested: start.requested }, start),
    known.report,
  );
  effectiveByThread.set(threadId, { started: true, report });
  return reporter(threadId, report);
}

/** Something the adapter or the harness said of a running session of a team thread. */
export function reportDeliveryPatch(
  threadId: ThreadId,
  patch: EffectivePatch,
): Effect.Effect<void> {
  const known = effectiveByThread.get(threadId);
  if (!known) return Effect.void;
  const report = withPatch(known.report, patch);
  if (sameReport(report, known.report)) return Effect.void;
  effectiveByThread.set(threadId, { started: known.started, report });
  return known.started && reporter
    ? reporter(threadId, { ...report, reason: "reported by the harness" })
    : Effect.void;
}

type TeamLookup = (threadId: string) => string | undefined;
let teamLookup: TeamLookup | undefined;

/** Set by DeliveryService. Answers from its record of bound threads, engine up or down. */
export function registerDeliveryTeamLookup(next: TeamLookup | undefined): void {
  teamLookup = next;
}

let terminalEntryScript: string | null = null;

/** Kept current by DeliveryService from settings. Null while delivery is off. */
export function setDeliveryTerminalEntryScript(next: string | null): void {
  terminalEntryScript = next;
}

export function deliveryTerminalEntryScript(): string | null {
  return terminalEntryScript;
}

/** The team a thread is bound to, or undefined for a manual thread. */
export function deliveryTeamOf(threadId: string): string | undefined {
  return teamLookup?.(threadId);
}
