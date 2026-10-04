import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { ATTENTION_BOARD_PATH, boardAttentionCount } from "../lib/deliveryBoard";
import { useDeliveryRead } from "../state/delivery";

const POLL_MS = 15_000;

/**
 * How many tasks wait for the person in this environment, for the badge on the
 * Board item. Null while that is not known, which shows no badge just as zero
 * does. It reads every board without a filter, so what the Board page shows
 * has no say in it. Pass the environment whose Board the item opens, and
 * whether delivery is on there: off, or with no environment, nothing is read.
 */
export function useBoardAttention(
  environmentId: EnvironmentId | null,
  enabled: boolean,
): number | null {
  const active = enabled ? environmentId : null;
  // A reading that failed keeps the body of the one before it, so only an answer
  // that came back malformed needs the last good count kept here.
  const { body } = useDeliveryRead(active, active ? ATTENTION_BOARD_PATH : null, {
    pollMs: POLL_MS,
  });
  // The last good reading. Its count is null once delivery went off or the environment
  // disconnected: that reading is then old, and is not shown again when it is still
  // the one at hand as delivery comes back.
  const [kept, setKept] = useState<{
    readonly environmentId: EnvironmentId;
    readonly body: unknown;
    readonly count: number | null;
  } | null>(null);
  if (active === null) {
    if (kept && kept.count !== null) setKept({ ...kept, count: null });
    return null;
  }
  // A count kept for another environment says nothing about this one.
  const mine = kept?.environmentId === active ? kept : null;
  if (mine && body === mine.body) return mine.count;
  const count = boardAttentionCount(body);
  if (count === null) return mine?.count ?? null;
  setKept({ environmentId: active, body, count });
  return count;
}
