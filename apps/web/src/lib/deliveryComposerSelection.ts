import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import type {
  DeliveryThreadBinding,
  EnvironmentId,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstanceEntry } from "../providerInstances";
import type { Thread } from "../types";
import { resolveComposerProviderSelection } from "../components/ChatView.logic";
import { deliveryEnvironment } from "../state/delivery";

const emptyDeliveryBindingAtom = Atom.make<DeliveryThreadBinding | null>(null);

/** Persisted bindings still constrain the server when new team controls are disabled. */
export function useDeliveryThreadModelBinding(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
) {
  return useAtomValue(
    threadId
      ? deliveryEnvironment.modelBinding({ environmentId, input: { threadId } })
      : emptyDeliveryBindingAtom,
  );
}

type ComposerSelectionInput = {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  activeThread: Thread | null | undefined;
  selectedProviderByThreadId: ProviderInstanceId | null;
  activeProjectDefaultModelSelection: ModelSelection | null | undefined;
  lockedProvider: ProviderDriverKind | null;
  deliveryBinding?: DeliveryThreadBinding | null | undefined;
};

/** ChatView's selection for send and conversation controls. */
export function useChatViewComposerProviderSelection(
  input: ComposerSelectionInput & {
    activeRuntime: Thread["runtime"];
  },
) {
  const runtimeInstanceId = input.activeRuntime?.providerInstanceId;
  const modelInstanceId = input.activeThread?.modelSelection.instanceId;
  const defaultInstanceId = input.activeProjectDefaultModelSelection?.instanceId;
  return useMemo(
    () =>
      resolveComposerProviderSelection({
        entries: input.entries,
        candidateInstanceIds: [
          input.selectedProviderByThreadId,
          runtimeInstanceId,
          modelInstanceId,
          defaultInstanceId,
        ],
        lockedProvider: input.lockedProvider,
        deliveryBinding: input.deliveryBinding,
        lockedInstanceId: runtimeInstanceId ?? modelInstanceId,
      }),
    [
      input.entries,
      input.selectedProviderByThreadId,
      runtimeInstanceId,
      modelInstanceId,
      defaultInstanceId,
      input.lockedProvider,
      input.deliveryBinding,
    ],
  );
}

/** ChatComposer's selection for the production model picker. */
export function useChatComposerProviderSelection(
  input: ComposerSelectionInput & {
    activeThreadModelSelection: ModelSelection | null | undefined;
  },
) {
  const runtimeInstanceId = input.activeThread?.runtime?.providerInstanceId;
  const modelInstanceId = input.activeThreadModelSelection?.instanceId;
  const defaultInstanceId = input.activeProjectDefaultModelSelection?.instanceId;
  return useMemo(
    () =>
      resolveComposerProviderSelection({
        entries: input.entries,
        candidateInstanceIds: [
          input.selectedProviderByThreadId,
          runtimeInstanceId,
          modelInstanceId,
          defaultInstanceId,
        ],
        lockedProvider: input.lockedProvider,
        deliveryBinding: input.deliveryBinding,
        lockedInstanceId: runtimeInstanceId ?? modelInstanceId,
      }),
    [
      input.entries,
      input.selectedProviderByThreadId,
      runtimeInstanceId,
      modelInstanceId,
      defaultInstanceId,
      input.lockedProvider,
      input.deliveryBinding,
    ],
  );
}
