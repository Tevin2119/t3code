import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { type DeliveryCard, parseCards } from "../../lib/delivery";
import { LANE_TITLE, queryValue } from "../../lib/deliveryBoard";
import { useDeliveryEnabled, useDeliveryRead, useStaleReading } from "../../state/delivery";
import { deliveryProgress, parseBoardDelivery } from "../../lib/boardDelivery";

export function useThreadDeliveryProgress(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const enabled = useDeliveryEnabled(environmentId);
  const origin = environmentId && threadId ? `thread:${environmentId}/${threadId}` : null;
  const read = useDeliveryRead(enabled && origin ? environmentId : null, "/api/delivery", {
    pollMs: 10_000,
  });
  const stale = useStaleReading(read.readAt);
  if (read.error || stale || !enabled) return [];
  return (parseBoardDelivery(read.body)?.tracking ?? [])
    .filter((row) => row.request?.origin === origin)
    .map((row) => deliveryProgress(row));
}

/**
 * The tasks a person made from this conversation, newest first. Empty when none was made,
 * when delivery is off, or while the engine has not answered.
 */
export function useThreadTasks(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<DeliveryCard> {
  const read = useThreadTasksRead(environmentId, threadId);
  return [...parseCards(read.body)].sort((a, b) => b.number - a.number);
}

/** The engine's reading of the tasks filed from this conversation, shared by all its views. */
export function useThreadTasksRead(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const enabled = useDeliveryEnabled(environmentId);
  const origin = environmentId && threadId ? `thread:${environmentId}/${threadId}` : null;
  return useDeliveryRead(
    enabled && origin ? environmentId : null,
    origin ? `/api/tasks?origin=${queryValue(origin)}&set=all&limit=500` : null,
    { pollMs: 5_000 },
  );
}

// Board lanes whose column names are too long for a one-word tag in a narrow row.
const SHORT_LANE: Readonly<Record<string, string>> = {
  "needs-decision": "Needs you",
  "human-review": "Sign-off",
  "child-work": "Child work",
  paused: "Paused",
  approved: "Approved",
  "pull-request": "PR open",
};

/** Where a task stands on the board, in a word or two. */
export const taskStandsIn = (task: Pick<DeliveryCard, "lane">): string =>
  SHORT_LANE[task.lane] ?? LANE_TITLE[task.lane] ?? (task.lane || "Task");
