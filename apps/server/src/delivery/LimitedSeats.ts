import { type ThreadId } from "@t3tools/contracts";
import type { LimitedSeatFacts, SeatLimit } from "@t3tools/shared/limitedSeat";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

/** How far back a conversation's failed seats and fork parents are read for a limit. */
const MAX_FAILED_SEATS = 24;
const MAX_FORK_PARENTS = 8;

export class LimitedSeats extends Context.Service<
  LimitedSeats,
  {
    /**
     * What decides whether a seat of this conversation is limited and what may stand in:
     * Favorites, provider status, and the usage limits its own turns and seats failed on.
     */
    readonly facts: (threadId: ThreadId) => Effect.Effect<LimitedSeatFacts>;
  }
>()("t3/delivery/LimitedSeats") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;

  const facts: LimitedSeats["Service"]["facts"] = Effect.fn("LimitedSeats.facts")(
    function* (threadId) {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const { subagents } = yield* projections.getThreadRecords(threadId, ["subagents"]);
      const failedSeats = subagents
        .filter((task) => task.teamChat !== undefined && task.status === "failed")
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
        )
        .slice(0, MAX_FAILED_SEATS)
        .flatMap((task) => (task.childThreadId === null ? [] : [task.childThreadId]));
      const threadLimits: Array<SeatLimit> = [];
      const read = Effect.fn("LimitedSeats.readLimit")(function* (id: ThreadId) {
        const shell = yield* projections.getThreadShell(id);
        if (
          shell?.lastErrorClass === "usage_limit" &&
          shell.status === "failed" &&
          (shell.usageLimitResetAt == null || Date.parse(shell.usageLimitResetAt) > now)
        ) {
          threadLimits.push({
            instanceId: shell.modelSelection.instanceId,
            model: shell.modelSelection.model,
            resetAt: shell.usageLimitResetAt ?? null,
          });
        }
        return shell;
      });
      // A conversation handed on from a limited lead must not be handed straight back.
      let current: ThreadId | null = threadId;
      for (let depth = 0; current !== null && depth <= MAX_FORK_PARENTS; depth += 1) {
        const shell: Effect.Success<ReturnType<typeof read>> = yield* read(current);
        current =
          shell?.lineage.relationshipToParent === "fork" ? shell.lineage.parentThreadId : null;
      }
      yield* Effect.forEach(failedSeats, read, { discard: true });
      const root = yield* projections.getThreadShell(threadId);
      return {
        now,
        providers: yield* Effect.forEach(
          yield* instances.listInstances,
          (instance) => instance.snapshot.getSnapshot,
        ),
        settings: yield* settings.getSettings,
        projectId: root?.projectId ?? null,
        threadLimits,
      };
    },
    // A limit that cannot be read is no limit: the seat starts as it always did.
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("limited-seats.facts-failed", cause).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                return {
                  now: DateTime.toEpochMillis(yield* DateTime.now),
                  providers: [],
                  settings: { favorites: [], providerInstances: {}, projectSettingsOverrides: {} },
                  projectId: null,
                  threadLimits: [],
                } satisfies LimitedSeatFacts;
              }),
            ),
          ),
        ),
      ),
  );
  return LimitedSeats.of({ facts });
});

export const layer = Layer.effect(LimitedSeats, make);
