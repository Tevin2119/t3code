/**
 * What a team thread really ran on, for the record the delivery engine keeps.
 *
 * Three things are kept apart. `requested` is what the person chose in the
 * composer. `passed` is what an adapter says it handed to the harness.
 * `confirmed` is what the harness itself said it runs on, in an answer or an
 * event of its own. Nothing here is read from what a model wrote, and a value
 * nobody reported stays empty: an echo of the request is not a confirmation.
 *
 * @module delivery/DeliveryEffective
 */
import {
  DELIVERY_HARNESS_BY_DRIVER,
  type ModelSelection,
  type ProviderRuntimeEvent,
  type RuntimeMode,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

export interface EffectiveValues {
  readonly harness?: string | null;
  readonly model?: string | null;
  readonly reasoning?: string | null;
  readonly access?: string | null;
  readonly runtimeMode?: string | null;
}

export interface EffectiveReport {
  readonly reason: string;
  readonly requested: EffectiveValues;
  readonly passed: EffectiveValues;
  readonly confirmed: EffectiveValues;
  readonly confirmedBy: Readonly<Record<string, string>>;
  readonly notApplied: ReadonlyArray<{ readonly setting: string; readonly why: string }>;
  /** What the adapter handed over, as it was sent: arguments and settings, with no secret. */
  readonly passedDetail?: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

/** The option of each driver that sets how hard the model reasons. */
const REASONING_OPTION_BY_DRIVER: Readonly<Record<string, string>> = {
  claudeAgent: "effort",
  codex: "reasoningEffort",
  opencode: "variant",
  pi: "thinking",
  kimi: "thinking",
  deepseek: "reasoning_effort",
};

/** The value a picker uses for "leave it to the harness", which is no choice of a level. */
const HARNESS_DEFAULT = "harness-default";

/**
 * A seat's access has one counterpart among the modes of a thread: full
 * access. The other modes ask a person, which no seat's access does, so they
 * are reported as the mode they are and as no access of a seat.
 */
export const accessOfRuntimeMode = (mode: RuntimeMode | undefined): string | null =>
  mode === "full-access" ? "full" : null;

export const runtimeModeOfAccess = (access: string | null | undefined): RuntimeMode | null =>
  access === "full" ? "full-access" : null;

export function reasoningOf(
  driver: string,
  modelSelection: ModelSelection | undefined,
): string | null {
  const option = REASONING_OPTION_BY_DRIVER[driver];
  if (!option || !modelSelection) return null;
  const value = getModelSelectionStringOptionValue(modelSelection, option);
  return value && value !== HARNESS_DEFAULT ? value : null;
}

/** What the person chose for a session that is starting. */
export function requestedOf(input: {
  readonly driver: string;
  readonly modelSelection: ModelSelection | undefined;
  readonly runtimeMode: RuntimeMode | undefined;
}): EffectiveValues {
  return {
    harness: DELIVERY_HARNESS_BY_DRIVER[input.driver] ?? null,
    model: input.modelSelection?.model ?? null,
    reasoning: reasoningOf(input.driver, input.modelSelection),
    access: accessOfRuntimeMode(input.runtimeMode),
    runtimeMode: input.runtimeMode ?? null,
  };
}

/**
 * Drivers whose session carries the model the harness answered with when the
 * session was opened. For every other driver the session's model is the one
 * that was asked for, which confirms nothing.
 */
const SESSION_MODEL_FROM_HARNESS: Readonly<Record<string, string>> = {
  codex: "the answer of Codex when the thread was opened",
};

export function confirmedBySession(
  driver: string,
  model: string | undefined,
): Pick<EffectiveReport, "confirmed" | "confirmedBy"> {
  const by = SESSION_MODEL_FROM_HARNESS[driver];
  return by && model
    ? { confirmed: { model }, confirmedBy: { model: by } }
    : { confirmed: {}, confirmedBy: {} };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

export type EffectivePatch = Partial<
  Pick<EffectiveReport, "passed" | "confirmed" | "confirmedBy" | "notApplied" | "passedDetail">
>;

/** What an adapter handed over, as a patch of the record. */
export function patchFromPassed(
  passed: Readonly<Record<string, unknown>>,
  at: string,
): EffectivePatch {
  const has = (name: string) => Object.hasOwn(passed, name);
  return {
    passed: {
      ...(has("model") ? { model: text(passed["model"]) } : {}),
      ...(has("reasoning") ? { reasoning: text(passed["reasoning"]) } : {}),
      ...(has("access") ? { access: text(passed["access"]) } : {}),
    },
    passedDetail: [{ at, ...passed }],
  };
}

/** What an event of a session says of what was passed and what the harness confirmed. */
export function patchFromRuntimeEvent(event: ProviderRuntimeEvent): EffectivePatch | null {
  if (event.type !== "session.configured") return null;
  const config = event.payload.config;

  // What an adapter says it handed over, at the start of the session or with a turn.
  if (isRecord(config.passed)) return patchFromPassed(config.passed, event.createdAt);

  // The harness read back after a level was set: pi, Kimi and the DeepSeek harness.
  if (isRecord(config.reasoning)) {
    const chosen = text(config.reasoning.chosen);
    const effective = text(config.reasoning.effective);
    const applied = config.reasoning.applied === true;
    return {
      passed: { reasoning: applied ? chosen : null },
      ...(effective
        ? {
            confirmed: { reasoning: effective },
            confirmedBy: { reasoning: "the harness, read back from its session" },
          }
        : {}),
      ...(chosen && !applied
        ? {
            notApplied: [
              {
                setting: "reasoning",
                why:
                  text(config.reasoning.why) ??
                  `the harness did not take the level ${chosen} for this model`,
              },
            ],
          }
        : {}),
    };
  }

  // The first message of Claude itself, which names the model and the mode it runs in.
  if (config.type === "system" && config.subtype === "init") {
    const model = text(config.model);
    return model
      ? { confirmed: { model }, confirmedBy: { model: "the first message of Claude itself" } }
      : null;
  }

  // What the Claude adapter handed over when it started the session. The model is handed
  // over with the context window it is to have, as in `claude-fable-5-1[1m]`, and Claude
  // names the model without it: the two are the same model.
  if (event.provider === "claudeAgent" && (config.model || config.effort)) {
    return {
      passed: {
        model: text(config.model)?.replace(/\[[^\]]*\]$/, "") ?? null,
        reasoning: text(config.effort),
      },
    };
  }
  return null;
}

/** Lays a patch over a report. A value once known is kept until another is reported. */
export function withPatch(report: EffectiveReport, patch: EffectivePatch): EffectiveReport {
  const known = (values: EffectiveValues | undefined) =>
    Object.fromEntries(Object.entries(values ?? {}).filter(([, value]) => value !== undefined));
  const settings = new Set((patch.notApplied ?? []).map((item) => item.setting));
  return {
    ...report,
    passed: { ...report.passed, ...known(patch.passed) },
    confirmed: { ...report.confirmed, ...known(patch.confirmed) },
    confirmedBy: { ...report.confirmedBy, ...patch.confirmedBy },
    notApplied: [
      ...report.notApplied.filter((item) => !settings.has(item.setting)),
      ...(patch.notApplied ?? []),
    ],
    // The last of each kind is kept: what the session was opened with, and the last turn.
    ...(report.passedDetail || patch.passedDetail
      ? {
          passedDetail: [
            ...(report.passedDetail ?? []).filter(
              (item) => !(patch.passedDetail ?? []).some((next) => next["when"] === item["when"]),
            ),
            ...(patch.passedDetail ?? []),
          ],
        }
      : {}),
  };
}

export const sameReport = (a: EffectiveReport, b: EffectiveReport): boolean =>
  JSON.stringify([a.passed, a.confirmed, a.confirmedBy, a.notApplied, withoutTimes(a)]) ===
  JSON.stringify([b.passed, b.confirmed, b.confirmedBy, b.notApplied, withoutTimes(b)]);

const withoutTimes = (report: EffectiveReport) =>
  (report.passedDetail ?? []).map(({ at: _at, ...rest }) => rest);
