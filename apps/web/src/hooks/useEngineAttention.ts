import type { EnvironmentId } from "@t3tools/contracts";

import { engineAttention, parseDeliveryEngineHealth } from "../lib/deliveryEngineControl";
import { useDeliveryRead } from "../state/delivery";

/**
 * Whether the primary environment's engine needs a person, such as an update to install. It reads
 * the same engine health as the Engine button, so the two never disagree.
 */
export function useEngineAttention(
  environmentId: EnvironmentId | null,
  enabled: boolean,
  connected: boolean,
): boolean {
  const active = enabled && connected ? environmentId : null;
  const health = useDeliveryRead(active, active ? "/api/health" : null, { pollMs: 30_000 });
  return !health.error && engineAttention(parseDeliveryEngineHealth(health.body).versions) !== null;
}
