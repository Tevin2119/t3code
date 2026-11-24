import {
  defaultInstanceIdForDriver,
  DELIVERY_HARNESS_BY_DRIVER,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";

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
