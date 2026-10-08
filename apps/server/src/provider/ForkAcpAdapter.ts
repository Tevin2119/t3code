import {
  ProviderDriverKind,
  type ProviderApprovalOption,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Options,
  type AcpAdapterV2RuntimeInput,
} from "../orchestration-v2/Adapters/AcpAdapterV2.ts";
import type * as AcpSessionRuntime from "./acp/AcpSessionRuntime.ts";
import { applyAcpSessionOption } from "./acp/AcpSessionOption.ts";
import { resolveHermesAcpModelId } from "./acp/HermesAcpSupport.ts";
import { resolveKimiAcpModelId } from "./acp/KimiAcpSupport.ts";
import { DEEPSEEK_MODEL_CONFIG_ID, resolveDeepSeekAcpModelId } from "./acp/DeepSeekAcpSupport.ts";
import {
  HERMES_RUNTIME_MODES,
  KIMI_RUNTIME_MODES,
  DEEPSEEK_RUNTIME_MODES,
  runtimeModeProblem,
} from "./runtimeModeSupport.ts";

export interface ForkAcpAdapterOptions extends Omit<AcpAdapterV2Options, "flavor"> {
  readonly instanceId: ProviderInstanceId;
  readonly makeRuntime: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | Scope.Scope
  >;
  readonly turnEnd?: (
    sessionId: string,
    before: number,
  ) => Effect.Effect<{ readonly endedWell: boolean; readonly why: string | undefined }>;
  readonly countTurnEnds?: (sessionId: string) => Effect.Effect<number>;
}

export function withNativeTurnReceipt(
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  options: Pick<ForkAcpAdapterOptions, "turnEnd" | "countTurnEnds">,
): AcpSessionRuntime.AcpSessionRuntime["Service"] {
  if (!options.turnEnd) return runtime;
  let sessionId: string | undefined;
  return {
    ...runtime,
    start: () =>
      runtime.start().pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            sessionId = result.sessionId;
          }),
        ),
      ),
    prompt: (payload, promptOptions) =>
      Effect.gen(function* () {
        const before =
          sessionId && options.countTurnEnds ? yield* options.countTurnEnds(sessionId) : 0;
        const result = yield* runtime.prompt(payload, promptOptions);
        if (result.stopReason === "end_turn" && sessionId && options.turnEnd) {
          const end = yield* options.turnEnd(sessionId, before);
          if (!end.endedWell)
            return yield* new EffectAcpErrors.AcpTransportError({
              detail: "The harness reported no successful native turn receipt.",
              cause: end,
            });
        }
        return result;
      }),
  };
}

export function forkApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const has = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.some((option) => option.kind === kind && option.optionId.trim());
  return [
    ...(has("allow_once") ? [{ decision: "accept" as const, label: "Allow once" }] : []),
    ...(has("allow_always")
      ? [{ decision: "acceptForSession" as const, label: "Allow for this thread" }]
      : []),
    ...(has("reject_once") ? [{ decision: "decline" as const, label: "Deny" }] : []),
    { decision: "cancel", label: "Cancel" },
  ];
}

/** Keep native failure receipts and permission limits while sharing the V2 ACP lifecycle. */
export function makeForkAcpAdapter(
  kind: "hermes" | "kimi" | "deepseek",
  options: ForkAcpAdapterOptions,
) {
  const support =
    kind === "hermes"
      ? HERMES_RUNTIME_MODES
      : kind === "kimi"
        ? KIMI_RUNTIME_MODES
        : DEEPSEEK_RUNTIME_MODES;
  return makeAcpAdapterV2({
    ...options,
    flavor: {
      driver: ProviderDriverKind.make(kind),
      capabilities: {
        ...AcpProviderCapabilitiesV2,
        sessions: { ...AcpProviderCapabilitiesV2.sessions, supportsModelSwitchInSession: true },
        threads: { ...AcpProviderCapabilitiesV2.threads, canRollbackThread: false },
        tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: true },
      },
      approvalOptions: forkApprovalOptions,
      resolveModelId: (selection) =>
        kind === "hermes"
          ? resolveHermesAcpModelId(selection.model)
          : kind === "kimi"
            ? resolveKimiAcpModelId(selection.model)
            : resolveDeepSeekAcpModelId(selection.model),
      applyModelSelection: (input) =>
        Effect.gen(function* () {
          const selected =
            kind === "hermes"
              ? resolveHermesAcpModelId(input.modelSelection.model)
              : kind === "kimi"
                ? resolveKimiAcpModelId(input.modelSelection.model)
                : resolveDeepSeekAcpModelId(input.modelSelection.model);
          if (selected) {
            if (kind === "deepseek")
              yield* input.runtime.setConfigOption(DEEPSEEK_MODEL_CONFIG_ID, selected);
            else yield* input.runtime.setSessionModel(selected);
          }
          if (kind !== "hermes") {
            const option = kind === "kimi" ? "thinking" : "reasoning_effort";
            const chosen = getModelSelectionStringOptionValue(input.modelSelection, option);
            const result = yield* applyAcpSessionOption(input.runtime, option, chosen);
            if (chosen && chosen !== "harness-default" && !result.applied)
              return yield* new EffectAcpErrors.AcpTransportError({
                detail: "The harness did not apply the requested reasoning option.",
                cause: result,
              });
          }
          return selected;
        }),
      makeRuntime: (input) =>
        Effect.gen(function* () {
          const problem = runtimeModeProblem(support, input.runtimePolicy.runtimeMode);
          if (problem)
            return yield* new EffectAcpErrors.AcpTransportError({
              detail: problem,
              cause: undefined,
            });
          const runtime = yield* options.makeRuntime(input);
          return withNativeTurnReceipt(runtime, options);
        }),
    },
  });
}
