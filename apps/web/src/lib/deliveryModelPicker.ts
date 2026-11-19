import { deliveryModelDisabledReason } from "@t3tools/client-runtime/delivery-model-lock";
import { msg } from "gt-react";
import { getStartedThreadModelChangeBlockReason } from "../components/ChatView.logic";
import { m, type MessageResolver } from "../i18n/messages";

export function getThreadModelDisabledReason(
  input: Parameters<typeof getStartedThreadModelChangeBlockReason>[0],
  resolve: MessageResolver = m,
) {
  const driver = input.providers?.find(
    (entry) => entry.instanceId === input.nextModelSelection.instanceId,
  )?.driver;
  const deliveryReason = deliveryModelDisabledReason(input.deliveryBinding, driver);
  if (deliveryReason) return deliveryReason;
  const reason = getStartedThreadModelChangeBlockReason(input, resolve);
  return reason
    ? resolve(msg("{reason} Start a new thread to use this model.", { reason: reason.description }))
    : null;
}
