import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/compat";

import { parseSessionUpdateEvent } from "./AcpRuntimeModel.ts";
import { ACP_OPTION_HARNESS_DEFAULT, applyAcpSessionOption } from "./AcpSessionOption.ts";

const option = (
  currentValue: string,
  values: ReadonlyArray<string>,
): EffectAcpSchema.SessionConfigOption =>
  ({
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  }) as EffectAcpSchema.SessionConfigOption;

/** A session that offers what it is given, and takes a value the way a harness does. */
const session = (
  offered: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  take: (value: string) => string = (value) => value,
) =>
  Effect.gen(function* () {
    const options = yield* Ref.make(offered);
    const sent = yield* Ref.make<ReadonlyArray<string>>([]);
    return {
      sent: Ref.get(sent),
      runtime: {
        getConfigOptions: Ref.get(options),
        setConfigOption: (configId: string, value: string | boolean) =>
          Effect.gen(function* () {
            yield* Ref.update(sent, (had) => [...had, `${configId}=${String(value)}`]);
            const next = (yield* Ref.get(options)).map((item) =>
              item.id === configId
                ? ({
                    ...item,
                    currentValue: take(String(value)),
                  } as EffectAcpSchema.SessionConfigOption)
                : item,
            );
            yield* Ref.set(options, next);
            return { configOptions: next };
          }),
      },
    };
  });

it.effect("sends nothing when no level was chosen, and says what the harness runs on", () =>
  Effect.gen(function* () {
    const kimi = yield* session([option("max", ["low", "high", "max"])]);
    const unset = yield* applyAcpSessionOption(kimi.runtime, "thinking", undefined);
    const byDefault = yield* applyAcpSessionOption(
      kimi.runtime,
      "thinking",
      ACP_OPTION_HARNESS_DEFAULT,
    );
    expect(yield* kimi.sent).toEqual([]);
    expect(unset).toMatchObject({ chosen: undefined, effective: "max", applied: false });
    expect(unset.why).toBeUndefined();
    expect(byDefault).toMatchObject({ chosen: undefined, effective: "max", applied: false });
  }),
);

it.effect("sets a chosen level the session offers, and reports the level the harness holds", () =>
  Effect.gen(function* () {
    const kimi = yield* session([option("high", ["low", "high", "max"])]);
    const outcome = yield* applyAcpSessionOption(kimi.runtime, "thinking", "low");
    expect(yield* kimi.sent).toEqual(["thinking=low"]);
    expect(outcome).toMatchObject({ chosen: "low", effective: "low", applied: true });
  }),
);

it.effect("does not send a level the model does not offer, and the session still starts", () =>
  Effect.gen(function* () {
    // kimi-for-coding-highspeed offers "on" and nothing else.
    const kimi = yield* session([option("on", ["on"])]);
    const outcome = yield* applyAcpSessionOption(kimi.runtime, "thinking", "high");
    expect(yield* kimi.sent).toEqual([]);
    expect(outcome).toMatchObject({ chosen: "high", effective: "on", applied: false });
    expect(outcome.why).toBe('this model offers on for "thinking", not "high"');
  }),
);

it.effect("says so when the session offers no such option at all", () =>
  Effect.gen(function* () {
    const hermes = yield* session([]);
    const outcome = yield* applyAcpSessionOption(hermes.runtime, "thinking", "high");
    expect(yield* hermes.sent).toEqual([]);
    expect(outcome).toMatchObject({ applied: false, effective: undefined, offered: [] });
    expect(outcome.why).toBe('this session offers no option "thinking"');
  }),
);

it.effect("does not call a level set that the harness did not take", () =>
  Effect.gen(function* () {
    const harness = yield* session([option("low", ["low", "high"])], () => "low");
    const outcome = yield* applyAcpSessionOption(harness.runtime, "thinking", "high");
    expect(outcome).toMatchObject({ chosen: "high", effective: "low", applied: false });
    expect(outcome.why).toBe('the harness reports "low" after "high" was set');
  }),
);

it("reads what a session says it holds of its context window", () => {
  const parsed = parseSessionUpdateEvent({
    sessionId: "s",
    update: { sessionUpdate: "usage_update", used: 42294, size: 1000000 },
  } as EffectAcpSchema.SessionNotification);
  expect(parsed.events).toEqual([
    expect.objectContaining({
      _tag: "UsageUpdated",
      usage: { usedTokens: 42294, maxTokens: 1000000 },
    }),
  ]);
});
