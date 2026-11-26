import { managedRuntimeModeDenial } from "@t3tools/client-runtime/contract-labels";
import type { ManagedPolicySummary, RuntimeMode, ServerProvider } from "@t3tools/contracts";
import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import {
  type LucideIcon,
  LockIcon,
  PenLineIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
} from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: msg("Supervised", { $context: "permission mode, agent asks before acting" }),
    description: msg("Ask before anything is written or changed. What only reads may run."),
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: msg("Auto-accept edits"),
    description: msg("Auto-approve edits, ask before other actions."),
    icon: PenLineIcon,
  },
  auto: {
    label: msg("Auto", { $context: "permission mode, provider approves routine actions" }),
    description: msg("Supported providers approve routine actions; others still ask."),
    icon: ShieldCheckIcon,
  },
  "full-access": {
    label: msg("Full access"),
    description: msg("Allow commands and edits without prompts."),
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

/**
 * The modes a draft's send can run in. A multi-model send gives every thread the draft's mode
 * and only that thread's provider narrows it, so the composer offers what any of them supports.
 */
export function draftSupportedRuntimeModes(
  activeProviderModes: ReadonlyArray<RuntimeMode> | undefined,
  multipleModelSelections: ReadonlyArray<{ readonly instanceId: string }> | null,
  providers: ReadonlyArray<{
    readonly instanceId: string;
    readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode> | undefined;
  }>,
) {
  if (multipleModelSelections === null || multipleModelSelections.length === 0) {
    return activeProviderModes;
  }
  const supported = multipleModelSelections.map(
    (selection) =>
      providers.find((provider) => provider.instanceId === selection.instanceId)
        ?.supportedRuntimeModes ?? [],
  );
  // A provider that reports no modes supports them all.
  if (supported.some((modes) => modes.length === 0)) return undefined;
  return runtimeModeOptions.filter((mode) => supported.some((modes) => modes.includes(mode)));
}

export function resolveRuntimeModeOption(
  mode: RuntimeMode,
  resolve: MessageResolver = m,
): {
  mode: RuntimeMode;
  label: string;
  description: string;
  icon: LucideIcon;
  disabledReason?: string;
} {
  const config = runtimeModeConfig[mode];
  return {
    mode,
    ...config,
    label: resolve(config.label),
    description: resolve(config.description),
  };
}

/** Why `mode` is unavailable under `managedPolicy`, or undefined when it is allowed. */
export function runtimeModeDenial(
  managedPolicy: ManagedPolicySummary | undefined,
  mode: RuntimeMode,
  resolve: MessageResolver = m,
) {
  const ceiling = managedPolicy?.limits?.maxRuntimeMode;
  if (ceiling === undefined || managedRuntimeModeDenial(managedPolicy, mode) === undefined) {
    return undefined;
  }
  return resolve(
    msg("{organization} limits threads to {mode}.", {
      organization: managedPolicy!.organization,
      mode: resolve(runtimeModeConfig[ceiling].label),
    }),
  );
}

export function resolveRuntimeModeOptions(
  modes: ReadonlyArray<RuntimeMode>,
  managedPolicy: ManagedPolicySummary | undefined,
  resolve: MessageResolver = m,
) {
  return modes.map((mode) => {
    const option = resolveRuntimeModeOption(mode, resolve);
    const disabledReason = runtimeModeDenial(managedPolicy, mode, resolve);
    return disabledReason === undefined ? option : { ...option, disabledReason };
  });
}
