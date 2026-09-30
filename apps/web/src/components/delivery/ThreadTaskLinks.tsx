import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { type DeliveryCard, parseCards } from "../../lib/delivery";
import { LANE_TITLE, queryValue } from "../../lib/deliveryBoard";
import { useDeliveryEnabled, useDeliveryRead } from "../../state/delivery";

/**
 * The tasks a person made from this conversation, newest first. Empty when none was made,
 * when delivery is off, or while the engine has not answered.
 */
export function useThreadTasks(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<DeliveryCard> {
  const enabled = useDeliveryEnabled(environmentId);
  const origin = environmentId && threadId ? `thread:${environmentId}/${threadId}` : null;
  const read = useDeliveryRead(
    enabled && origin ? environmentId : null,
    origin ? `/api/tasks?origin=${queryValue(origin)}&set=all&limit=10` : null,
    { pollMs: 15_000 },
  );
  return useMemo(() => [...parseCards(read.body)].sort((a, b) => b.number - a.number), [read.body]);
}

/** Where a task stands, as the Board's column names it. */
export const taskStandsIn = (task: Pick<DeliveryCard, "lane">): string =>
  LANE_TITLE[task.lane ?? ""] ?? task.lane ?? "task";
