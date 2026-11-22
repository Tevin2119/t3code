import { msg } from "gt-react";
import { GitForkIcon } from "lucide-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { Button } from "../ui/button";

import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Why a handed-on thread's composer sends nothing: the server refuses every message to it. */
export function handedOnThreadSendBlockReason(resolve: MessageResolver = m) {
  return resolve(msg("This conversation continues in a linked thread"));
}

/** Shown above the composer of a thread whose limited run continues in a linked thread. */
export function handedOnThreadBannerItem(
  onOpenThread: () => void,
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  return {
    id: "handed-on-thread",
    variant: "info",
    icon: <GitForkIcon />,
    title: handedOnThreadSendBlockReason(resolve),
    actions: (
      <Button size="xs" variant="outline" onClick={onOpenThread}>
        {resolve(msg("Open thread"))}
      </Button>
    ),
  };
}
