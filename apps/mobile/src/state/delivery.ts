import { createDeliveryEnvironmentAtoms } from "@t3tools/client-runtime/state/delivery";
import { Atom } from "effect/reactivity";
import type { DeliveryThreadBinding } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";

export const deliveryEnvironment = createDeliveryEnvironmentAtoms(connectionAtomRuntime);
export const emptyDeliveryBindingAtom = Atom.make<DeliveryThreadBinding | null>(null);
