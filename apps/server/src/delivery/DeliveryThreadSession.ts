import type { DeliveryError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type EffectivePatch,
  type EffectiveReport,
  sameReport,
  withPatch,
} from "./DeliveryEffective.ts";

/** A stdio MCP server the delivery engine wants a thread's harness to have. */
export interface DeliveryToolServer {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

/** What a team-bound thread's harness is given, fetched before the session starts. */
export interface DeliveryThreadSession {
  readonly threadId: ThreadId;
  readonly team: string;
  readonly role: string;
  readonly configuration: string;
  readonly instructions: string;
  readonly servers: Readonly<Record<string, DeliveryToolServer>>;
  /** The instructions as a file, for a harness that takes a path and not text. */
  readonly instructionsFile?: string | undefined;
  /** A skill folder naming the team's tools as commands, for a harness without MCP. */
  readonly skillFolder?: string | undefined;
}

// Keyed by thread like `McpProviderSession`, so adapters can read it
// synchronously at session start and at every turn.
const sessionsByThread = new Map<ThreadId, DeliveryThreadSession>();

export function setDeliveryThreadSession(session: DeliveryThreadSession): void {
  sessionsByThread.set(session.threadId, session);
}

export function readDeliveryThreadSession(threadId: ThreadId): DeliveryThreadSession | undefined {
  return sessionsByThread.get(threadId);
}

export function clearDeliveryThreadSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllDeliveryThreadSessions(): void {
  sessionsByThread.clear();
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
  if (sessionsByThread.has(threadId)) {
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

/** The team's layers, framed so a harness can tell them from T3 Code's own runtime notes. */
export function deliveryInstructions(threadId: ThreadId | undefined): string {
  const session = threadId ? sessionsByThread.get(threadId) : undefined;
  if (!session) return "";
  return `<team_instructions team="${session.team}" role="${session.role}" configuration="${session.configuration}">\n${session.instructions.trim()}\n</team_instructions>`;
}

/** Stdio servers keyed by name, the shape the Claude SDK and OpenCode take. */
export function deliveryStdioServers(
  threadId: ThreadId,
): Record<
  string,
  { readonly command: string; readonly args: Array<string>; readonly env: Record<string, string> }
> {
  const session = sessionsByThread.get(threadId);
  if (!session) return {};
  return Object.fromEntries(
    Object.entries(session.servers).map(([name, server]) => [
      name,
      { command: server.command, args: [...server.args], env: { ...server.env } },
    ]),
  );
}

/**
 * A TOML string holding only letters, digits and a few marks: every other
 * character is written as a TOML escape. On Windows Codex is started through
 * `cmd.exe` and its own `.cmd` file, which read the command line twice. A
 * quote, `<`, `>`, `&` or `%` in a team's instructions would be taken there
 * as the shell's own, and Codex would not start.
 */
export const tomlString = (value: string) =>
  `"${Array.from(value, (char) => {
    if (/[A-Za-z0-9 _./:-]/.test(char)) return char;
    const code = char.codePointAt(0) ?? 0;
    return code > 0xffff
      ? `\\U${code.toString(16).padStart(8, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  }).join("")}"`;

/**
 * Codex takes configuration as `-c key=value` with TOML values. The team's
 * instructions are set for the session here, and again on each turn that
 * carries developer instructions, because those replace the session's.
 */
export function deliveryCodexArgs(threadId: ThreadId): ReadonlyArray<string> {
  const session = sessionsByThread.get(threadId);
  if (!session) return [];
  const args = ["-c", `developer_instructions=${tomlString(deliveryInstructions(threadId))}`];
  for (const [name, server] of Object.entries(session.servers)) {
    args.push("-c", `mcp_servers.${name}.command=${tomlString(server.command)}`);
    args.push("-c", `mcp_servers.${name}.args=[${server.args.map(tomlString).join(",")}]`);
    const env = Object.entries(server.env);
    if (env.length > 0) {
      args.push(
        "-c",
        `mcp_servers.${name}.env={${env.map(([key, value]) => `${key}=${tomlString(value)}`).join(",")}}`,
      );
    }
  }
  return args;
}

/** pi has no MCP. It is given the instructions as a file and the tools as a skill. */
export function deliveryPiLaunch(threadId: ThreadId): {
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
} {
  const session = sessionsByThread.get(threadId);
  if (!session) return { args: [], env: {} };
  return {
    args: [
      ...(session.instructionsFile ? ["--append-system-prompt", session.instructionsFile] : []),
      ...(session.skillFolder ? ["--skill", session.skillFolder] : []),
    ],
    env: Object.assign({}, ...Object.values(session.servers).map((server) => server.env)),
  };
}

/** ACP `session/new` entries. The stdio variant has no `type` key. */
export function deliveryAcpServers(threadId: ThreadId): ReadonlyArray<{
  readonly name: string;
  readonly command: string;
  readonly args: Array<string>;
  readonly env: Array<{ readonly name: string; readonly value: string }>;
}> {
  const session = sessionsByThread.get(threadId);
  if (!session) return [];
  return Object.entries(session.servers).map(([name, server]) => ({
    name,
    command: server.command,
    args: [...server.args],
    env: Object.entries(server.env).map(([key, value]) => ({ name: key, value })),
  }));
}
