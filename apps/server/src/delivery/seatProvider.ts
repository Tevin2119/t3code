import {
  defaultInstanceIdForDriver,
  DELIVERY_HARNESS_BY_DRIVER,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
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
