import type {
  DeliveryThreadBinding,
  DeliveryThreadState,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

/** Only a confirmed binding in this thread's query can restrict its models. */
export function confirmedDeliveryBinding<E>(
  result: AsyncResult.AsyncResult<DeliveryThreadState, E>,
  threadId: string,
): DeliveryThreadBinding | null {
  return result._tag === "Success" && result.value.binding?.threadId === threadId
    ? result.value.binding
    : null;
}

export function deliveryBindingAtom<E>(
  query: Atom.Atom<AsyncResult.AsyncResult<DeliveryThreadState, E>>,
  threadId: string,
) {
  return Atom.map(query, (result) => confirmedDeliveryBinding(result, threadId));
}

export function deliveryModelDisabledReason(
  binding: DeliveryThreadBinding | null | undefined,
  driver: string | null | undefined,
): string | null {
  return binding && binding.driver !== driver
    ? `This thread is the ${binding.team} ${binding.role} on ${binding.harness}. Start a new thread to use another harness.`
    : null;
}

/** Reuse picker eligibility for browsing, favorites, search, and keyboard navigation. */
export function matchesModelPickerLock(
  entry: { driverKind: string; continuationGroupKey?: string | null | undefined },
  lockedProvider: string | null,
  continuationGroupKey?: string | null | undefined,
): boolean {
  return (
    lockedProvider === null ||
    (entry.driverKind === lockedProvider &&
      (!continuationGroupKey || entry.continuationGroupKey === continuationGroupKey))
  );
}

export function modelPickerDisabledInstanceIds<
  T extends {
    instanceId: ProviderInstanceId;
    driverKind: string;
    continuationGroupKey?: string | null | undefined;
  },
>(
  entries: ReadonlyArray<T>,
  lockedProvider: string | null,
  continuationGroupKey?: string | null | undefined,
) {
  return lockedProvider === null
    ? undefined
    : new Set(
        entries
          .filter((entry) => !matchesModelPickerLock(entry, lockedProvider, continuationGroupKey))
          .map((entry) => entry.instanceId),
      );
}
