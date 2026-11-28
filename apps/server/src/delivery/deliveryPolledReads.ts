import type { DeliveryError, DeliveryResponse } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

/** A heavy read with the store generation the engine served it at, when the engine names one. */
export interface GenerationRead {
  readonly response: DeliveryResponse;
  readonly generation: number | null;
}

/**
 * Board and task reads change only with a store write, except for fields the engine derives from
 * its clock (leases, waits, heartbeats, nudges). A kept read is served again while the generation
 * holds, and read afresh once this old so those fields stay current.
 */
export const KEPT_READ_CEILING_MS = 30_000;
/** One generation answer serves every kept read asked within this window. */
export const GENERATION_PROBE_MS = 2_000;
/**
 * The generation is the whole store's, so while a team works it moves on most reads and a probe
 * would only add a request. Once a read sees it move, reads go straight to the engine this long.
 */
export const BUSY_ENGINE_MS = 10_000;
const KEPT_READ_LIMIT = 64;

const generationGated = (path: string) => /^\/api\/(lanes|tasks)(\/[\w-]+)?(\?|$)/.test(path);

/**
 * Client reads of one engine: identical reads in flight share one request, and board and task
 * reads are asked again only once the store generation moved. `invalidate` runs on every write
 * T3 relays and every settings change, so nothing read before it is served after it.
 */
export function makeDeliveryPolledReads(options: {
  readonly scope: Scope.Scope;
  readonly read: (path: string) => Effect.Effect<GenerationRead, DeliveryError>;
  readonly generation: Effect.Effect<number, DeliveryError>;
}) {
  let epoch = 0;
  const inFlight = new Map<string, Fiber.Fiber<GenerationRead, DeliveryError>>();
  const kept = new Map<string, { generation: number; body: unknown; at: number }>();
  // The newest generation the engine named, from a probe or from any heavy read's header, and
  // when the read that named it began: a heavy read of one path is a free probe for the others.
  let known: { at: number; generation: number } | null = null;
  let probing: Fiber.Fiber<number | null> | null = null;
  let movedAt = Number.NEGATIVE_INFINITY;
  const learn = (at: number, generation: number, readEpoch: number) => {
    if (readEpoch !== epoch || (known !== null && at < known.at)) return;
    if (known !== null && generation !== known.generation) movedAt = at;
    known = { at, generation };
  };

  // Forked into the service scope: a caller that leaves does not cancel the read for the others.
  const shared = <A, E>(effect: Effect.Effect<A, E>) => Effect.forkIn(effect, options.scope);

  const currentGeneration = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now - movedAt < BUSY_ENGINE_MS) return null;
    if (known !== null && now - known.at < GENERATION_PROBE_MS) return known.generation;
    if (probing === null) {
      const readEpoch = epoch;
      const fiber: Fiber.Fiber<number | null> = yield* shared(
        options.generation.pipe(
          Effect.tap((generation) => Effect.sync(() => learn(now, generation, readEpoch))),
          Effect.orElseSucceed(() => null),
          Effect.ensuring(
            Effect.sync(() => {
              if (probing === fiber) probing = null;
            }),
          ),
        ),
      );
      probing = fiber;
    }
    return yield* Fiber.join(probing);
  });

  const heavyRead = Effect.fnUntraced(function* (path: string) {
    const existing = inFlight.get(path);
    if (existing) return yield* Fiber.join(existing);
    const readEpoch = epoch;
    const at = yield* Clock.currentTimeMillis;
    const fiber = yield* shared(
      options.read(path).pipe(
        Effect.tap(({ response, generation }) =>
          Effect.sync(() => {
            if (generation === null || readEpoch !== epoch) return;
            learn(at, generation, readEpoch);
            if (!generationGated(path)) return;
            if (kept.size >= KEPT_READ_LIMIT && !kept.has(path)) {
              kept.delete(kept.keys().next().value!);
            }
            kept.set(path, { generation, body: response.body, at });
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (inFlight.get(path) === fiber) inFlight.delete(path);
          }),
        ),
      ),
    );
    inFlight.set(path, fiber);
    return yield* Fiber.join(fiber);
  });

  const read = Effect.fn("DeliveryPolledReads.read")(function* (path: string) {
    const entry = kept.get(path);
    const age = entry ? (yield* Clock.currentTimeMillis) - entry.at : Number.POSITIVE_INFINITY;
    if (entry && age < KEPT_READ_CEILING_MS) {
      const readEpoch = epoch;
      // A read begun within the probe window is as fresh as a probe: another window's poll.
      const generation = age < GENERATION_PROBE_MS ? entry.generation : yield* currentGeneration;
      if (generation === entry.generation && readEpoch === epoch && kept.get(path) === entry) {
        return {
          readAt: DateTime.formatIso(yield* DateTime.now),
          body: entry.body,
        } satisfies DeliveryResponse;
      }
    }
    return (yield* heavyRead(path)).response;
  });

  const invalidate = () => {
    epoch++;
    inFlight.clear();
    kept.clear();
    known = null;
    probing = null;
  };

  return { read, invalidate };
}
