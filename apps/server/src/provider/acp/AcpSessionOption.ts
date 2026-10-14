/**
 * Sets one option of an ACP session to what a person chose, and says what the
 * session then runs on.
 *
 * Harnesses name their options themselves and offer them per session and per
 * model: Kimi calls its level of reasoning `thinking`, DeepSeek
 * `reasoning_effort`, and the values differ with the model. So nothing is sent
 * unless a person chose a value, a value the session does not offer is not
 * sent, and what the session reports afterwards is what is shown.
 *
 * @module provider/acp/AcpSessionOption
 */
import * as Effect from "effect/Effect";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  collectSessionConfigOptionValues,
  findSessionConfigOption,
} from "@t3tools/provider-acp/server/runtimeModel";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

type Runtime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  "getConfigOptions" | "setConfigOption"
>;

/** The value of the picker that means: leave the harness on its own setting. */
export const ACP_OPTION_HARNESS_DEFAULT = "harness-default";

export interface AcpSessionOptionOutcome {
  readonly option: string;
  /** What the person chose, or undefined when the harness was left on its own setting. */
  readonly chosen: string | undefined;
  /** What the session offers for this option. Empty when it does not offer the option. */
  readonly offered: ReadonlyArray<string>;
  /** What the session reports for the option after the change, if it reports one. */
  readonly effective: string | undefined;
  readonly applied: boolean;
  /** Set when a chosen value was not applied. */
  readonly why?: string;
}

const currentValueOf = (option: { readonly currentValue?: unknown } | undefined) =>
  typeof option?.currentValue === "string" ? option.currentValue : undefined;

export const applyAcpSessionOption = (
  runtime: Runtime,
  configId: string,
  chosen: string | undefined,
): Effect.Effect<AcpSessionOptionOutcome, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const wanted =
      chosen === undefined || chosen === ACP_OPTION_HARNESS_DEFAULT ? undefined : chosen;
    const before = findSessionConfigOption(yield* runtime.getConfigOptions, configId);
    const offered = before ? collectSessionConfigOptionValues(before) : [];
    const base = { option: configId, chosen: wanted, offered };
    if (wanted === undefined) {
      return { ...base, effective: currentValueOf(before), applied: false };
    }
    if (!before) {
      return {
        ...base,
        effective: undefined,
        applied: false,
        why: `this session offers no option "${configId}"`,
      };
    }
    if (!offered.includes(wanted)) {
      return {
        ...base,
        effective: currentValueOf(before),
        applied: false,
        why: `this model offers ${offered.join(", ") || "no values"} for "${configId}", not "${wanted}"`,
      };
    }
    yield* runtime.setConfigOption(configId, wanted);
    const after = findSessionConfigOption(yield* runtime.getConfigOptions, configId);
    const effective = currentValueOf(after);
    return effective === wanted
      ? { ...base, effective, applied: true }
      : {
          ...base,
          effective,
          applied: false,
          why: `the harness reports "${effective ?? "nothing"}" after "${wanted}" was set`,
        };
  });
