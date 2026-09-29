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
): ReadonlyArray<ServerProviderRuntimeModeSupport> {
  return ALL_MODES.map((mode) => {
    const reason = unavailable[mode];
    return reason ? { mode, available: false, reason } : { mode, available: true };
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

export const DEEPSEEK_RUNTIME_MODES = runtimeModeSupport({
  "auto-accept-edits": ASKS_EVERYTHING("The DeepSeek harness"),
  auto: NO_REVIEWER("The DeepSeek harness"),
});

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
