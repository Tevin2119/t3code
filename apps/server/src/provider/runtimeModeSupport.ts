/**
 * Which access modes a provider can honour, and why it cannot honour the rest.
 *
 * A mode means the same thing for every provider:
 *
 *   approval-required   a person is asked before anything is written or changed, by a file
 *                       tool or by a command. What only reads may run without asking.
 *   auto-accept-edits   file changes are made without asking, commands are asked about
 *   auto                a reviewer of the provider's own approves routine actions
 *   full-access         nothing is asked and nothing is refused
 *
 * A provider that has no way to honour a mode does not run it as another one. The mode is
 * shown as unavailable with the reason, and a session asked to start in it is refused.
 *
 * DIVERGES FROM UPSTREAM, which offers all four modes for every provider and lets each
 * adapter fall back by itself: pi then runs every mode with full access, and the ACP
 * providers run three of them as Supervised.
 *
 * @module provider/runtimeModeSupport
 */
import type { RuntimeMode, ServerProviderRuntimeModeSupport } from "@t3tools/contracts";

const ALL_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/** Every mode, each available unless a reason is given for it. */
export function runtimeModeSupport(
  unavailable: Partial<Record<RuntimeMode, string>> = {},
  notes: Partial<Record<RuntimeMode, string>> = {},
): ReadonlyArray<ServerProviderRuntimeModeSupport> {
  return ALL_MODES.map((mode) => {
    const reason = unavailable[mode];
    const note = notes[mode];
    if (reason) return { mode, available: false, reason };
    return note ? { mode, available: true, note } : { mode, available: true };
  });
}

/** Why this provider cannot run in this mode, or undefined when it can. */
export function runtimeModeProblem(
  support: ReadonlyArray<ServerProviderRuntimeModeSupport> | undefined,
  mode: RuntimeMode,
): string | undefined {
  const entry = support?.find((item) => item.mode === mode);
  return entry && !entry.available
    ? (entry.reason ?? "This provider cannot run in this mode.")
    : undefined;
}

const ASKS_EVERYTHING = (name: string) =>
  `${name} asks before every action it needs leave for, or before none. It has no mode that lets file changes through and asks about the rest.`;
const NO_REVIEWER = (name: string) =>
  `${name} has no reviewer of its own to approve routine actions.`;

// Tried through T3 Code on 2026-09-29. Claude reported the mode as in effect. Asked by the
// person to delete a folder outside the working folder, the reviewer let the command run. It
// was not seen to stop anything: what was tried beside that, Claude declined by itself.
export const CLAUDE_RUNTIME_MODES = runtimeModeSupport(
  {},
  {
    auto: "Claude's own reviewer decides what runs without asking. It was seen to let a delete outside the working folder run when the person had asked for it, and was not seen to stop anything. Use Supervised where a person is to be asked.",
  },
);

export const PI_RUNTIME_MODES = runtimeModeSupport({
  "approval-required":
    "pi has no way to ask a person before it acts, and no sandbox. It would run with full access.",
  "auto-accept-edits":
    "pi has no way to ask a person before it acts, and no sandbox. It would run with full access.",
  auto: "pi has no reviewer of its own, no way to ask a person, and no sandbox. It would run with full access.",
});

export const KIMI_RUNTIME_MODES = runtimeModeSupport({
  "auto-accept-edits": ASKS_EVERYTHING("Kimi"),
  auto: NO_REVIEWER("Kimi"),
});

// Supervised on the DeepSeek harness is its read-only mode. Tried through T3 Code on
// 2026-09-29: it asked before its file tool wrote and before a command that writes, did what
// was approved and left what was declined, and asked again for the next write.
export const DEEPSEEK_RUNTIME_MODES = runtimeModeSupport(
  {
    "auto-accept-edits": ASKS_EVERYTHING("The DeepSeek harness"),
    auto: NO_REVIEWER("The DeepSeek harness"),
  },
  {
    "approval-required":
      "The DeepSeek harness runs in its read-only mode: it reads without asking, and asks before anything that writes, by its file tool or by a command.",
  },
);

// Tried through T3 Code on 2026-09-29: asked to run a shell command that writes a file,
// Hermes ran it without asking. It asks before its file tool changes a file, and before a
// command it takes for dangerous, and a command can change a file as well as the tool can.
const HERMES_ASKS_IN_PART =
  "Hermes asks before its file tool changes a file, and runs shell commands without asking unless it takes them for dangerous. A command can change a file too, so nothing here would be supervised.";
export const HERMES_RUNTIME_MODES = runtimeModeSupport({
  "approval-required": HERMES_ASKS_IN_PART,
  "auto-accept-edits": `${HERMES_ASKS_IN_PART} Hermes has a mode that accepts edits, which T3 Code does not set.`,
  auto: NO_REVIEWER("Hermes"),
});

export const OPENCODE_RUNTIME_MODES = runtimeModeSupport({
  auto: `${NO_REVIEWER("OpenCode")} It would ask as Supervised does.`,
});

/** What a Codex sandbox that cannot start takes away: every mode that runs inside it. */
export function codexRuntimeModes(sandboxProblem: string | undefined) {
  if (!sandboxProblem) return runtimeModeSupport();
  const reason = `Codex runs this mode inside its sandbox, which cannot start on this host: ${sandboxProblem}. Put the sandbox right in Codex, or use Full access.`;
  return runtimeModeSupport({
    "approval-required": reason,
    "auto-accept-edits": reason,
    auto: reason,
  });
}
