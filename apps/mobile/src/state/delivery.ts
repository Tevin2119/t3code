import { createDeliveryEnvironmentAtoms } from "@t3tools/client-runtime/state/delivery";
import { Atom } from "effect/reactivity";
import type { DeliveryThreadBinding } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadShells } from "./threads";

export const deliveryEnvironment = createDeliveryEnvironmentAtoms(connectionAtomRuntime, {
  threadShellAtom: environmentThreadShells.threadShellAtom,
});
export const emptyDeliveryBindingAtom = Atom.make<DeliveryThreadBinding | null>(null);
