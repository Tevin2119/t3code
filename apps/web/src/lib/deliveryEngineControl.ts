import { DeliveryEngineUpdateReceipt, DeliveryEngineVersions } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeVersions = Schema.decodeUnknownOption(DeliveryEngineVersions);
const decodeUpdateReceipt = Schema.decodeUnknownOption(DeliveryEngineUpdateReceipt);

export function parseDeliveryEngineHealth(body: unknown) {
  const record: Record<string, unknown> =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const field = (name: string): unknown => record[name] ?? null;
  const code = field("code");
  const commit =
    typeof code === "object" && code !== null && "commit" in code && typeof code.commit === "string"
      ? code.commit
      : null;
  const profile = field("profile");
  const pid = field("pid");
  return {
    stopping: field("stopping") === true,
    profile: typeof profile === "string" ? profile : null,
    pid: typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null,
    commit,
    versions: Option.getOrNull(decodeVersions(field("versions"))),
    approval: field("approval") === "passphrase" ? "passphrase" : "terminal-key",
  };
}

export function requireDeliveryUpdateReceipt(body: unknown) {
  const receipt = decodeUpdateReceipt(body);
  if (Option.isNone(receipt)) {
    throw new Error(
      "The supervisor did not confirm accepting this update. Inspect the engine terminal before trying again.",
    );
  }
  return receipt.value;
}

export function deliveryUpdatePending(id: string | null, versions: DeliveryEngineVersions | null) {
  if (id === null) return false;
  const update = versions?.update;
  if (update?.id !== id) return true;
  if (update.phase === "failed") return false;
  return update.phase !== "complete" || versions?.running?.commit !== update.commit;
}

export async function controlDeliveryEngine(
  action: "start" | "stop" | "restart",
  operations: {
    readonly stop: () => Promise<unknown>;
    readonly start: () => Promise<void>;
  },
): Promise<void> {
  if (action !== "start") {
    const receipt = await operations.stop();
    if (
      typeof receipt !== "object" ||
      receipt === null ||
      !("stopped" in receipt) ||
      receipt.stopped !== true
    ) {
      throw new Error("The engine did not confirm a completed stop. Nothing else was started.");
    }
  }
  if (action !== "stop") await operations.start();
}
