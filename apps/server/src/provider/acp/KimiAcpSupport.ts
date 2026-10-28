// Kimi speaks ACP directly; use the shared runtime rather than a separate transport.
import { type KimiSettings, ProviderDriverKind } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const KIMI_DRIVER_KIND = ProviderDriverKind.make("kimi");

/**
 * The only auth method `kimi acp` advertises. It is a terminal flow: the agent
 * re-execs itself with `--login` and runs the device-code exchange in a TTY,
 * so T3 Code never sees an authorization URL to open in a browser.
 */
const KIMI_AUTH_METHOD_ID = "login";

/** Model alias `kimi provider list` reports as the account default. */
export const KIMI_DEFAULT_MODEL_SLUG = "kimi-code/kimi-for-coding";

export type KimiAcpRuntimeSettings = Pick<KimiSettings, "binaryPath">;

export interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: KimiAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

function kimiAcpSpawnArgs(): ReadonlyArray<string> {
  // `kimi acp` takes no permission-mode flags: approval policy is negotiated
  // per tool call over ACP `session/request_permission`.
  return ["acp"];
}

function buildKimiAcpSpawnInput(
  kimiSettings: KimiAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kimiSettings?.binaryPath || "kimi",
    args: [...kimiAcpSpawnArgs()],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

/** Arguments for the terminal sign-in entry point the agent advertises. */
export function kimiLoginArgs(region: KimiSettings["region"]): ReadonlyArray<string> {
  return ["login", "--region", region];
}

// Prefer the URL's user_code over CLI wording so rephrased device-login prompts still work.
export function parseKimiLoginChallenge(
  output: string,
): { readonly verificationUrl: string; readonly verificationCode: string | undefined } | undefined {
  const urls = output.match(/https?:\/\/[^\s'"]+/g) ?? [];
  // The region decides the host (kimi.ai vs kimi.com), so the path is what
  // identifies the sign-in link among any other URL the CLI may print.
  const url = urls.find((candidate) => /authorize|device|login/i.test(candidate)) ?? urls[0];
  if (!url) return undefined;
  const verificationUrl = url.replace(/[).,;]+$/, "");
  const fromUrl = verificationUrl.match(/[?&]user_code=([^&\s]+)/i)?.[1];
  const fromPrompt = output.match(/enter code:\s*([A-Za-z0-9-]{4,})/i)?.[1];
  return {
    verificationUrl,
    verificationCode: fromUrl ? decodeURIComponent(fromUrl) : fromPrompt,
  };
}

export const makeKimiAcpRuntime = Effect.fn("makeKimiAcpRuntime")(function* (
  input: KimiAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> {
  const acpContext = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      spawn: buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment),
      authMethodId: KIMI_AUTH_METHOD_ID,
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

/**
 * Kimi accepts fully-qualified `provider/model` aliases over ACP, which is also
 * what the model picker stores, so the slug passes through unchanged apart from
 * the shared alias normalization.
 */
export function resolveKimiAcpModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : KIMI_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, KIMI_DRIVER_KIND) ?? KIMI_DEFAULT_MODEL_SLUG;
}

export function currentKimiModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.ForkSessionResponse
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}
