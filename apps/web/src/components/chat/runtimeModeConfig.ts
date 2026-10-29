import type { RuntimeMode, ServerProvider } from "@t3tools/contracts";
import { type LucideIcon, LockIcon, PenLineIcon, ShieldOffIcon, SparklesIcon } from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before anything is written or changed. What only reads may run.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    // An open lock reads like a closed one at small sizes; a crossed shield does not.
    icon: ShieldOffIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

export type RuntimeModeSupport = ServerProvider["runtimeModes"];

/** What was seen of a mode that is offered on the chosen provider, where there is something to say. */
export function runtimeModeNote(
  support: RuntimeModeSupport,
  mode: RuntimeMode,
): string | undefined {
  const entry = support?.find((item) => item.mode === mode);
  return entry?.available ? entry.note : undefined;
}

/** Why the chosen provider cannot run in this mode, or undefined when it can. */
export function runtimeModeUnavailableReason(
  support: RuntimeModeSupport,
  mode: RuntimeMode,
): string | undefined {
  const entry = support?.find((item) => item.mode === mode);
  return entry && !entry.available
    ? (entry.reason ?? "This provider cannot run in this mode.")
    : undefined;
}

/** The modes a provider supports (all when it reports none) and the mode a thread really runs in. */
export function resolveCompatibleRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  const modes =
    supportedRuntimeModes && supportedRuntimeModes.length > 0
      ? runtimeModeOptions.filter((mode) => supportedRuntimeModes.includes(mode))
      : runtimeModeOptions;
  return { modes, mode: modes.includes(runtimeMode) ? runtimeMode : (modes[0] ?? runtimeMode) };
}
