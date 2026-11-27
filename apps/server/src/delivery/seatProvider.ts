import {
  defaultInstanceIdForDriver,
  DELIVERY_HARNESS_BY_DRIVER,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { modelAccountFamily } from "@t3tools/shared/limitedSeat";
import { createModelSelection } from "@t3tools/shared/model";
import * as Schema from "effect/Schema";

export const BoardLeadSeat = Schema.Struct({
  seat: Schema.String,
  role: Schema.optional(Schema.NullOr(Schema.String)),
});

export function boardLeadSeat<T extends typeof BoardLeadSeat.Type>(seats: ReadonlyArray<T>) {
  return (
    seats.find((seat) => seat.role === "team-lead") ?? seats.find((seat) => seat.seat === "lead")
  );
}

export function resolveSeatProvider<T extends { readonly driverKind: ProviderDriverKind }>(
  providers: ReadonlyArray<T>,
  harness: string,
  instanceIdOf: (provider: T) => ProviderInstanceId,
  preferredInstanceId?: ProviderInstanceId,
): T | "no-provider" | "ambiguous-provider" {
  const candidates = providers.filter(
    (provider) => DELIVERY_HARNESS_BY_DRIVER[provider.driverKind] === harness,
  );
  if (candidates.length === 0) return "no-provider";
  if (candidates.length === 1) return candidates[0]!;
  // A harness names a driver, not an account.
  return (
    candidates.find(
      (candidate) =>
        instanceIdOf(candidate) ===
        (preferredInstanceId ?? defaultInstanceIdForDriver(candidate.driverKind)),
    ) ?? "ambiguous-provider"
  );
}

/**
 * The selection a thread's next turn takes for an engine pick: the pick itself when it is a model
 * of the same account family the thread runs on, so the turn switches model in place. Undefined
 * when the pick names no provider here, or another family: the thread cannot switch to it.
 */
export function turnSelection(
  providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: ProviderDriverKind;
    readonly enabled: boolean;
  }>,
  current: ModelSelection,
  pick: { readonly harness: string; readonly model: string },
): ModelSelection | undefined {
  const existing = providers.find((provider) => provider.instanceId === current.instanceId);
  const next = resolveSeatProvider(
    providers.filter((provider) => provider.enabled),
    pick.harness,
    (provider) => provider.instanceId,
    current.instanceId,
  );
  if (
    typeof next === "string" ||
    modelAccountFamily(existing?.driverKind, current.model) !==
      modelAccountFamily(next.driverKind, pick.model)
  )
    return undefined;
  return next.instanceId === current.instanceId && pick.model === current.model
    ? current
    : createModelSelection(next.instanceId, pick.model);
}
