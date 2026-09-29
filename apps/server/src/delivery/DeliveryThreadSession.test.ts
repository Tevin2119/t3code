import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { EffectiveReport } from "./DeliveryEffective.ts";
import * as DeliveryThreadSession from "./DeliveryThreadSession.ts";

const THREAD = ThreadId.make("thread-effective");

const bound = () =>
  DeliveryThreadSession.setDeliveryThreadSession({
    threadId: THREAD,
    team: "rnd",
    role: "research-lead",
    configuration: "rnd@1#0000000000000000",
    instructions: "x",
    servers: {},
  });

const collecting = () => {
  const reports: Array<EffectiveReport> = [];
  DeliveryThreadSession.registerDeliveryReporter((_threadId, report) =>
    Effect.sync(() => void reports.push(report)),
  );
  return reports;
};

const reset = Effect.sync(() => {
  DeliveryThreadSession.registerDeliveryReporter(undefined);
  DeliveryThreadSession.clearAllDeliveryThreadSessions();
});

it.effect("keeps what an adapter reports while a session starts, and sends it with the start", () =>
  Effect.gen(function* () {
    const reports = collecting();
    bound();
    DeliveryThreadSession.beginDeliveryEffective(THREAD);

    yield* DeliveryThreadSession.reportDeliveryPatch(THREAD, {
      passed: { reasoning: "high" },
      confirmed: { reasoning: "high" },
      confirmedBy: { reasoning: "the harness, read back from its session" },
    });
    expect(reports).toHaveLength(0);

    yield* DeliveryThreadSession.reportDeliveryStart(THREAD, {
      reason: "the session was started",
      requested: { harness: "kimi", model: "kimi-for-coding", reasoning: "high" },
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.requested.model).toBe("kimi-for-coding");
    expect(reports[0]?.passed).toEqual({ reasoning: "high" });
    expect(reports[0]?.confirmed).toEqual({ reasoning: "high" });

    // Said again, nothing new is sent. Something new is.
    yield* DeliveryThreadSession.reportDeliveryPatch(THREAD, { passed: { reasoning: "high" } });
    expect(reports).toHaveLength(1);
    yield* DeliveryThreadSession.reportDeliveryPatch(THREAD, {
      confirmed: { model: "kimi-for-coding" },
      confirmedBy: { model: "the harness" },
    });
    expect(reports).toHaveLength(2);
    expect(reports[1]?.requested.model).toBe("kimi-for-coding");

    // The next session of the thread starts from nothing known.
    DeliveryThreadSession.beginDeliveryEffective(THREAD);
    yield* DeliveryThreadSession.reportDeliveryStart(THREAD, {
      reason: "the session was started again",
      requested: { harness: "kimi", model: "kimi-for-coding-highspeed" },
    });
    expect(reports[2]?.confirmed).toEqual({});
  }).pipe(Effect.ensuring(reset)),
);

it.effect("reports nothing for a thread with no team", () =>
  Effect.gen(function* () {
    const reports = collecting();
    DeliveryThreadSession.beginDeliveryEffective(THREAD);
    yield* DeliveryThreadSession.reportDeliveryStart(THREAD, {
      reason: "the session was started",
      requested: { harness: "codex", model: "gpt-6-luna" },
    });
    yield* DeliveryThreadSession.reportDeliveryPatch(THREAD, { confirmed: { model: "x" } });
    expect(reports).toHaveLength(0);
  }).pipe(Effect.ensuring(reset)),
);
