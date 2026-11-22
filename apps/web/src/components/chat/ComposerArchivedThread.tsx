import { msg } from "gt-react";
import { ArchiveIcon } from "lucide-react";

import { m, type MessageResolver } from "../../i18n/messages";

import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Why an archived thread's composer sends nothing: the server refuses every message to it. */
export function archivedThreadSendBlockReason(resolve: MessageResolver = m) {
  return resolve(msg("This thread is archived and cannot receive messages."));
}

/** Shown above the composer of an archived thread, which opens to read and takes no message. */
export function archivedThreadBannerItem(resolve: MessageResolver = m): ComposerBannerStackItem {
  return {
    id: "archived-thread",
    variant: "info",
    icon: <ArchiveIcon />,
    title: archivedThreadSendBlockReason(resolve),
  };
}
