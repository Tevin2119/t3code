// Use the shared ACP runtime and fixed terminal auth method; provider-specific auth IDs vary by host.
import * as NodeOS from "node:os";

import { HERMES_DEFAULT_MODEL, type HermesSettings, ProviderDriverKind } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const HERMES_DRIVER_KIND = ProviderDriverKind.make("hermes");

// The fixed method verifies credentials without starting Hermes' interactive setup wizard.
const HERMES_AUTH_METHOD_ID = "hermes-setup";

export type HermesAcpRuntimeSettings = Pick<
  HermesSettings,
  "binaryPath" | "homePath" | "acceptHooks"
>;

export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function hermesAcpSpawnArgs(
  hermesSettings: Pick<HermesSettings, "acceptHooks"> | null | undefined,
): ReadonlyArray<string> {
  // `hermes acp` takes no permission-mode flags: approval policy is negotiated
  // per tool call over ACP `session/request_permission`. `--accept-hooks` is
  // the exception, without it Hermes waits on a TTY prompt T3 Code cannot
  // answer the first time it sees a project's shell hooks.
  return hermesSettings?.acceptHooks ? ["acp", "--accept-hooks"] : ["acp"];
}

// ACP and CLI probes must share HERMES_HOME so they read the same credentials and sessions.
export function makeHermesEnvironment(
  hermesSettings: Pick<HermesSettings, "homePath"> | null | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const homePath = hermesSettings?.homePath.trim() ?? "";
  if (homePath.length === 0) return baseEnv;
  return { ...baseEnv, HERMES_HOME: expandHomePath(homePath, NodeOS.homedir()) };
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const env = hermesSettings?.homePath.trim()
    ? makeHermesEnvironment(hermesSettings, environment)
    : environment;
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: [...hermesAcpSpawnArgs(hermesSettings)],
    cwd,
    ...(env ? { env } : {}),
  };
}

export const makeHermesAcpRuntime = Effect.fn("makeHermesAcpRuntime")(function* (
  input: HermesAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> {
  const acpContext = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
      authMethodId: HERMES_AUTH_METHOD_ID,
    }).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
    Effect.provide(acpContext),
  );
});

/** The `provider:model` id Hermes uses for a model over ACP. */
export function hermesModelSlug(provider: string, model: string): string {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim();
  if (!normalizedModel) return "";
  return normalizedProvider ? `${normalizedProvider}:${normalizedModel}` : normalizedModel;
}

/**
 * The model id to send over ACP, or `undefined` to keep whatever Hermes is
 * configured with. Hermes model ids carry the provider (`deepseek:…`) and the
 * configured pair differs per machine, so the default alias never goes out on
 * the wire, it means "leave the session's own selection alone".
 */
export function resolveHermesAcpModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === HERMES_DEFAULT_MODEL) return undefined;
  return normalizeModelSlug(trimmed, HERMES_DRIVER_KIND) ?? undefined;
}

export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.ForkSessionResponse
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}
