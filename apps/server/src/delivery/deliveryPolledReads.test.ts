import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  BUSY_ENGINE_MS,
  GENERATION_PROBE_MS,
  KEPT_READ_CEILING_MS,
  makeDeliveryPolledReads,
} from "./deliveryPolledReads.ts";

const LANES = "/api/lanes?view=development&set=all";

/** An engine that counts what it is asked: heavy reads by path, and generation probes. */
const fakeEngine = Effect.fnUntraced(function* (
  options: {
    readonly hold?: Deferred.Deferred<void>;
    readonly generations?: boolean;
  } = {},
) {
  const engine = { generation: 1, probes: 0, reads: new Map<string, number>() };
  const polled = makeDeliveryPolledReads({
    scope: yield* Effect.scope,
    read: (path) =>
      Effect.gen(function* () {
        engine.reads.set(path, (engine.reads.get(path) ?? 0) + 1);
        const generation = engine.generation;
        if (options.hold) yield* Deferred.await(options.hold);
        return {
          response: { readAt: "", body: { path, generation } },
          generation: options.generations === false ? null : generation,
        };
      }),
    generation: Effect.sync(() => {
      engine.probes++;
      return engine.generation;
    }),
  });
  const readsOf = (path: string) => engine.reads.get(path) ?? 0;
  return { engine, polled, readsOf };
});

it.effect("ten identical reads in flight make one engine request", () =>
  Effect.gen(function* () {
    const hold = yield* Deferred.make<void>();
    const { polled, readsOf } = yield* fakeEngine({ hold });
    const fibers = yield* Effect.forEach(Array.from({ length: 10 }), () =>
      Effect.forkChild(polled.read(LANES)),
    );
    yield* Deferred.succeed(hold, undefined);
    const bodies = yield* Effect.forEach(fibers, Fiber.join);
    assert.strictEqual(readsOf(LANES), 1);
    assert.strictEqual(bodies.length, 10);
  }).pipe(Effect.scoped),
);

it.effect("an unchanged generation serves the kept read, one probe for every path", () =>
  Effect.gen(function* () {
    const { engine, polled, readsOf } = yield* fakeEngine();
    const task = "/api/tasks/T-1";
    yield* polled.read(LANES);
    yield* polled.read(task);
    yield* TestClock.adjust(GENERATION_PROBE_MS);

    const again = yield* polled.read(LANES);
    yield* polled.read(task);
    assert.deepStrictEqual(again.body, { path: LANES, generation: 1 });
    assert.strictEqual(readsOf(LANES), 1);
    assert.strictEqual(readsOf(task), 1);
    assert.strictEqual(engine.probes, 1);
  }).pipe(Effect.scoped),
);

it.effect("a moved generation reads again", () =>
  Effect.gen(function* () {
    const { engine, polled, readsOf } = yield* fakeEngine();
    yield* polled.read(LANES);
    engine.generation = 2;
    yield* TestClock.adjust(GENERATION_PROBE_MS);

    const fresh = yield* polled.read(LANES);
    assert.strictEqual(readsOf(LANES), 2);
    assert.deepStrictEqual(fresh.body, { path: LANES, generation: 2 });
  }).pipe(Effect.scoped),
);

it.effect(
  "a kept read past the ceiling reads again, for fields the engine takes from its clock",
  () =>
    Effect.gen(function* () {
      const { engine, polled, readsOf } = yield* fakeEngine();
      yield* polled.read(LANES);
      yield* TestClock.adjust(KEPT_READ_CEILING_MS);

      yield* polled.read(LANES);
      assert.strictEqual(readsOf(LANES), 2);
      assert.strictEqual(engine.probes, 0);
    }).pipe(Effect.scoped),
);

it.effect("a write T3 relays drops what was kept and what is in flight", () =>
  Effect.gen(function* () {
    const hold = yield* Deferred.make<void>();
    const { polled, readsOf } = yield* fakeEngine({ hold });
    const before = yield* Effect.forkChild(polled.read(LANES));
    yield* Effect.yieldNow;
    polled.invalidate();
    const after = yield* Effect.forkChild(polled.read(LANES));
    yield* Deferred.succeed(hold, undefined);
    yield* Fiber.join(before);
    yield* Fiber.join(after);
    assert.strictEqual(readsOf(LANES), 2);

    // Only the read begun after the write is kept, so the next read is served from it.
    yield* polled.read(LANES);
    assert.strictEqual(readsOf(LANES), 2);
    polled.invalidate();
    yield* polled.read(LANES);
    assert.strictEqual(readsOf(LANES), 3);
  }).pipe(Effect.scoped),
);

it.effect("an engine that names no generation is read every time, and never probed", () =>
  Effect.gen(function* () {
    const { engine, polled, readsOf } = yield* fakeEngine({ generations: false });
    yield* polled.read(LANES);
    yield* polled.read(LANES);
    assert.strictEqual(readsOf(LANES), 2);
    assert.strictEqual(engine.probes, 0);
  }).pipe(Effect.scoped),
);

it.effect("a read that is not of the board is never kept", () =>
  Effect.gen(function* () {
    const { engine, polled, readsOf } = yield* fakeEngine();
    yield* polled.read("/api/health");
    yield* polled.read("/api/tasks/T-1/feed");
    yield* polled.read("/api/health");
    yield* polled.read("/api/tasks/T-1/feed");
    assert.strictEqual(readsOf("/api/health"), 2);
    assert.strictEqual(readsOf("/api/tasks/T-1/feed"), 2);
    assert.strictEqual(engine.probes, 0);
  }).pipe(Effect.scoped),
);

it.effect("while the generation keeps moving, reads go straight to the engine unprobed", () =>
  Effect.gen(function* () {
    const { engine, polled, readsOf } = yield* fakeEngine();
    yield* polled.read(LANES);
    engine.generation = 2;
    yield* TestClock.adjust(GENERATION_PROBE_MS);
    yield* polled.read(LANES);
    assert.strictEqual(engine.probes, 1);

    yield* TestClock.adjust(GENERATION_PROBE_MS);
    yield* polled.read(LANES);
    assert.strictEqual(readsOf(LANES), 3);
    assert.strictEqual(engine.probes, 1);

    yield* TestClock.adjust(BUSY_ENGINE_MS);
    yield* polled.read(LANES);
    assert.strictEqual(readsOf(LANES), 3);
    assert.strictEqual(engine.probes, 2);
  }).pipe(Effect.scoped),
);

it.effect("another window's poll within the probe window is served from the read just made", () =>
  Effect.gen(function* () {
    const { engine, polled, readsOf } = yield* fakeEngine();
    yield* polled.read(LANES);
    engine.generation = 2;
    yield* TestClock.adjust(GENERATION_PROBE_MS - 1);
    yield* polled.read(LANES);
    assert.strictEqual(readsOf(LANES), 1);
    assert.strictEqual(engine.probes, 0);
  }).pipe(Effect.scoped),
);
