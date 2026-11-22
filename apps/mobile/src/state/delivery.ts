import { createDeliveryEnvironmentAtoms } from "@t3tools/client-runtime/state/delivery";
import { Atom } from "effect/reactivity";
import type { DeliveryThreadBinding } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

export const deliveryEnvironment = createDeliveryEnvironmentAtoms(connectionAtomRuntime, {
  threadShellAtom: environmentThreadShells.threadShellAtom,
  settingsAtom: serverEnvironment.settingsValueAtom,
  providersAtom: serverEnvironment.providersValueAtom,
});
export const emptyDeliveryBindingAtom = Atom.make<DeliveryThreadBinding | null>(null);
