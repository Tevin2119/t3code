import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  DeepSeekSettings,
  HermesSettings,
  KimiSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";

/** The provider client definitions this web build ships, in presentation order. */
export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  // Fork-only drivers, served from apps/server rather than a provider package.
  {
    driverKind: ProviderDriverKind.make("kimi"),
    label: "Kimi",
    badgeLabel: "Early Access",
    settingsSchema: KimiSettings,
  },
  {
    driverKind: ProviderDriverKind.make("hermes"),
    label: "Hermes",
    badgeLabel: "Early Access",
    settingsSchema: HermesSettings,
  },
  {
    driverKind: ProviderDriverKind.make("deepseek"),
    label: "DeepSeek",
    badgeLabel: "Early Access",
    settingsSchema: DeepSeekSettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);
