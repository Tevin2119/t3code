/**
 * Hermes Agent ACP wiring.
 *
 * `hermes acp` runs the CLI as an Agent Client Protocol server over stdio, so
 * the generic `AcpSessionRuntime` drives it directly the same way it drives
 * `kimi acp` — there is no bespoke transport to translate.
 *
 * Verified against Hermes Agent 0.21.1. Its `initialize` response advertises
 * protocol version 1, `loadSession`, session `resume`/`list`/`fork`, and two
 * auth methods: the configured inference provider (whose id *is* the provider
 * name, so it differs per machine) and the fixed terminal method
 * `hermes-setup`. T3 Code authenticates with the fixed one because it is the
 * only id known before the handshake, and Hermes answers both from the same
 * credential check.
 *
 * Hermes fronts whichever provider `hermes model` selected — DeepSeek on a
 * default install — and reports models as `provider:model` pairs, so T3 Code
 * ships no model catalog of its own.
 *
 * @module provider/acp/HermesAcpSupport
 */
import { HERMES_DEFAULT_MODEL, type HermesSettings, ProviderDriverKind } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const HERMES_DRIVER_KIND = ProviderDriverKind.make("hermes");

/**
 * The one auth method id `hermes acp` always advertises. Hermes also offers a
 * method named after the configured provider, but that id is only known after
 * `initialize`, and both resolve to the same check: credentials present or not.
 * The method is declared terminal because Hermes expects `hermes acp --setup`
 * to have run out of band; T3 Code never spawns that TTY flow itself.
 */
export const HERMES_AUTH_METHOD_ID = "hermes-setup";

export type HermesAcpRuntimeSettings = Pick<HermesSettings, "binaryPath" | "acceptHooks">;

export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function hermesAcpSpawnArgs(
  hermesSettings: HermesAcpRuntimeSettings | null | undefined,
): ReadonlyArray<string> {
  // `hermes acp` takes no permission-mode flags: approval policy is negotiated
  // per tool call over ACP `session/request_permission`. `--accept-hooks` is
  // the exception — without it Hermes waits on a TTY prompt T3 Code cannot
  // answer the first time it sees a project's shell hooks.
  return hermesSettings?.acceptHooks ? ["acp", "--accept-hooks"] : ["acp"];
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: [...hermesAcpSpawnArgs(hermesSettings)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

/** Arguments for the interactive provider/model setup the agent advertises. */
export function hermesSetupArgs(): ReadonlyArray<string> {
  return ["acp", "--setup"];
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
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
 * the wire — it means "leave the session's own selection alone".
 */
export function resolveHermesAcpModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === HERMES_DEFAULT_MODEL) return undefined;
  return normalizeModelSlug(trimmed, HERMES_DRIVER_KIND) ?? undefined;
}

export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}
