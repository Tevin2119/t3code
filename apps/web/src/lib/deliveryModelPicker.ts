import { deliveryModelDisabledReason } from "@t3tools/client-runtime/delivery-model-lock";
import { getStartedThreadModelChangeBlockReason } from "../components/ChatView.logic";

export function getThreadModelDisabledReason(
  input: Parameters<typeof getStartedThreadModelChangeBlockReason>[0],
) {
  const driver = input.providers?.find(
    (entry) => entry.instanceId === input.nextModelSelection.instanceId,
  )?.driver;
  const deliveryReason = deliveryModelDisabledReason(input.deliveryBinding, driver);
  if (deliveryReason) return deliveryReason;
  const reason = getStartedThreadModelChangeBlockReason(input);
  return reason ? `${reason.description} Start a new thread to use this model.` : null;
}
