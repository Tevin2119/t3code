/**
 * What a team-bound thread's harness is given: the delivery team's
 * instructions and stdio MCP servers, keyed by thread.
 *
 * FORK-ONLY. The delivery service in apps/server writes these before a bound
 * thread's session starts; provider adapters, here and in apps/server, read
 * them synchronously at session start and at every turn.
 *
 * @module provider-core/server/deliveryThreadSession
 */
import type { ThreadId } from "@t3tools/contracts";

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

export function clearDeliveryThreadSessions(): void {
  sessionsByThread.clear();
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
