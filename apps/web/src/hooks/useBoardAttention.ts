import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { ATTENTION_BOARD_PATH, boardAttentionCount } from "../lib/deliveryBoard";
import { useDeliveryRead } from "../state/delivery";

const POLL_MS = 15_000;

type Reading = { readonly body: unknown; readonly readAt: string | null };
const NO_READING: Reading = { body: null, readAt: null };

/**
 * How many tasks wait for the person in this environment, for the badge on the
 * Board item. Null while that is not known, which shows no badge just as zero
 * does. It reads every board without a filter, so what the Board page shows
 * has no say in it. Pass the environment whose Board the item opens, whether
 * delivery is on there, and whether the environment is connected: settings
 * are kept through a disconnect, so delivery being on does not say it is.
 * Without all three nothing is read and nothing is known.
 */
export function useBoardAttention(
  environmentId: EnvironmentId | null,
  enabled: boolean,
  connected: boolean,
): number | null {
  const active = enabled && connected ? environmentId : null;
  // A reading that failed keeps the body of the one before it, and so the count
  // before it. An answer that came back malformed is a reading of its own: its
  // count is not known, and no earlier count is shown in its place.
  const { body, readAt } = useDeliveryRead(active, active ? ATTENTION_BOARD_PATH : null, {
    pollMs: POLL_MS,
  });
  // What is known for the environment read now. Every change of it starts over, and
  // the reading at hand at that moment is from before the change: it is not counted,
  // so going away and coming back does not bring an old count with it. A reading is
  // told by its body and by when it was read: an answer of null was read at some
  // time, which no reading at all was not.
  const [kept, setKept] = useState<{
    readonly active: EnvironmentId | null;
    readonly old: Reading;
    readonly counted: Reading;
    readonly count: number | null;
  }>({ active, old: NO_READING, counted: NO_READING, count: null });
  if (kept.active !== active) {
    setKept({ active, old: { body, readAt }, counted: NO_READING, count: null });
    return null;
  }
  const isReading = (reading: Reading) => reading.body === body && reading.readAt === readAt;
  if (active === null || isReading(kept.old) || isReading(kept.counted)) return kept.count;
  const count = boardAttentionCount(body);
  setKept({ ...kept, counted: { body, readAt }, count });
  return count;
}
