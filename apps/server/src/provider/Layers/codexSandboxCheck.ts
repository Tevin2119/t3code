/**
 * Whether Codex can start its sandbox on this host.
 *
 * Every access mode of Codex except full access runs commands inside the sandbox. On Windows
 * the sandbox can fail to start, and a thread in one of those modes then cannot run a command
 * at all. The check asks Codex itself, with the person's own settings: `codex sandbox` runs one
 * harmless command the way a session would. The settings of Codex are never changed from here.
 *
 * @module provider/Layers/codexSandboxCheck
 */
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { spawnAndCollect } from "../providerSnapshot.ts";

const SANDBOX_CHECK_TIMEOUT = "45 seconds" as const;
const SANDBOX_CHECK_WORD = "sandbox-ok";

/** What Codex said of a sandbox that did not start: its last line, kept short. */
export function codexSandboxProblemFrom(result: {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}): string | undefined {
  if (result.code === 0 && result.stdout.includes(SANDBOX_CHECK_WORD)) return undefined;
  const said = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  return (said ?? `codex sandbox ended with code ${result.code}`).slice(0, 200);
}

/** The problem with the sandbox of Codex, or undefined when it starts or need not be asked. */
export const checkCodexSandbox = Effect.fn("checkCodexSandbox")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): Effect.fn.Return<string | undefined, never, ChildProcessSpawner.ChildProcessSpawner> {
  if ((input.platform ?? process.platform) !== "win32") return undefined;
  const environment = {
    ...(input.environment ?? process.env),
    ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
  };
  const command = input.binaryPath || "codex";
  const result = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      ["sandbox", "--", "cmd", "/c", `echo ${SANDBOX_CHECK_WORD}`],
      { env: environment },
    );
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(SANDBOX_CHECK_TIMEOUT), Effect.result);
  // A Codex that is missing is reported by the provider check, not here.
  if (result._tag === "Failure") return undefined;
  if (Option.isNone(result.success)) return "codex sandbox gave no answer in 45 seconds";
  return codexSandboxProblemFrom(result.success.value);
});
