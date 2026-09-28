/**
 * DeepSeek Harness ACP wiring.
 *
 * `dsh --profile acp` runs the harness as an Agent Client Protocol server over
 * stdio, so the generic `AcpSessionRuntime` drives it directly the same way it
 * drives `hermes acp`.
 *
 * Verified against dsh 0.1.5-rc.3. Its `initialize` response advertises
 * protocol version 1, session `resume`/`list`/`close` and no auth methods; it
 * accepts any `authenticate` request, because the API key is resolved from the
 * harness home when a turn runs. Models are a `model` config option whose
 * values are JSON pairs of backend and model id, so they are set through
 * `session/set_config_option` and never through `session/set_model`.
 *
 * @module provider/acp/DeepSeekAcpSupport
 */
import { type DeepSeekSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { expandHomePath } from "../../pathExpansion.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/** dsh advertises no auth method and accepts any id; this one names what it checks. */
export const DEEPSEEK_AUTH_METHOD_ID = "deepseek-api-key";
/** The backend the harness ships for DeepSeek's own API. */
export const DEEPSEEK_OFFICIAL_BACKEND = "deepseek-official";
export const DEEPSEEK_MODEL_CONFIG_ID = "model";

export type DeepSeekAcpRuntimeSettings = Pick<DeepSeekSettings, "binaryPath" | "homePath">;

export interface DeepSeekAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly deepseekSettings: DeepSeekAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function deepseekAcpSpawnArgs(): ReadonlyArray<string> {
  // Approval policy is negotiated per tool call over ACP `session/request_permission`.
  return ["--profile", "acp"];
}

/**
 * The environment every dsh subprocess of an instance runs with. A configured
 * `homePath` is exported as `DSH_HOME`, which is where the harness reads its
 * profiles and credentials from. With no `homePath` the base environment passes
 * through untouched, including any `DSH_HOME` it already carries.
 */
export function makeDeepSeekEnvironment(
  deepseekSettings: Pick<DeepSeekSettings, "homePath"> | null | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const homePath = deepseekSettings?.homePath.trim() ?? "";
  if (homePath.length === 0) return baseEnv;
  return { ...baseEnv, DSH_HOME: expandHomePath(homePath) };
}

export function buildDeepSeekAcpSpawnInput(
  deepseekSettings: DeepSeekAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const env = deepseekSettings?.homePath.trim()
    ? makeDeepSeekEnvironment(deepseekSettings, environment)
    : environment;
  return {
    command: deepseekSettings?.binaryPath || "dsh",
    args: [...deepseekAcpSpawnArgs()],
    cwd,
    ...(env ? { env } : {}),
  };
}

export const makeDeepSeekAcpRuntime = (
  input: DeepSeekAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDeepSeekAcpSpawnInput(input.deepseekSettings, input.cwd, input.environment),
        authMethodId: DEEPSEEK_AUTH_METHOD_ID,
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
 * The config value dsh expects for a model: a JSON pair of backend and model
 * id. A bare slug names a model of the official backend, and `backend/model`
 * names one of another backend the harness is configured with.
 */
export function resolveDeepSeekAcpModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  const separator = trimmed.indexOf("/");
  const backend = separator > 0 ? trimmed.slice(0, separator) : DEEPSEEK_OFFICIAL_BACKEND;
  const id = separator > 0 ? trimmed.slice(separator + 1) : trimmed;
  return id ? `["${backend}","${id}"]` : undefined;
}

/** The slug T3 Code shows for a model config value dsh reports. */
export function deepseekModelSlugFromConfigValue(value: string): string | undefined {
  const pair = /^\s*\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]\s*$/.exec(value);
  if (!pair) return undefined;
  const [, backend, id] = pair;
  return backend === DEEPSEEK_OFFICIAL_BACKEND ? id : `${backend}/${id}`;
}

export function currentDeepSeekModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const option = sessionSetupResult.configOptions?.find(
    (candidate) => candidate.id === DEEPSEEK_MODEL_CONFIG_ID,
  );
  return typeof option?.currentValue === "string" ? option.currentValue : undefined;
}
