import type { DeliveryError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

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
}

type Preparer = (threadId: ThreadId) => Effect.Effect<boolean, DeliveryError>;
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
export function prepareDeliveryThread(threadId: ThreadId): Effect.Effect<boolean, DeliveryError> {
  return preparer ? preparer(threadId) : Effect.succeed(false);
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

const tomlString = (value: string) => JSON.stringify(value);

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
