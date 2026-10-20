import { DeliveryEngineUpdateReceipt, DeliveryEngineVersions } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeVersions = Schema.decodeUnknownOption(DeliveryEngineVersions);
const decodeUpdateReceipt = Schema.decodeUnknownOption(DeliveryEngineUpdateReceipt);

export function parseDeliveryEngineHealth(body: unknown, person?: string) {
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
    approvalWindow: parseApprovalWindow(field("approvalWindow"), person),
    fullAuto: parseFullAuto(field("fullAuto")),
    stopping: field("stopping") === true,
    profile: typeof profile === "string" ? profile : null,
    pid: typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null,
    commit,
    versions: Option.getOrNull(decodeVersions(field("versions"))),
    approval: field("approval") === "passphrase" ? "passphrase" : "terminal-key",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseApprovalWindow(value: unknown, person?: string) {
  if (!isRecord(value) || typeof value.open !== "boolean") return null;
  if (!value.open) return { open: false, by: null, until: null };
  if (!Array.isArray(value.windows)) return null;
  const windows = value.windows
    .filter(isRecord)
    .flatMap((entry) =>
      typeof entry.by === "string" &&
      typeof entry.expiresAt === "string" &&
      Number.isFinite(Date.parse(entry.expiresAt))
        ? [{ by: entry.by, until: entry.expiresAt }]
        : [],
    )
    .sort((a, b) => Date.parse(b.until) - Date.parse(a.until));
  if (value.windows.length > 0 && windows.length === 0) return null;
  const window = person ? windows.find((entry) => entry.by === person) : undefined;
  return window ? { open: true, ...window } : { open: true, by: null, until: null };
}

function parseFullAuto(value: unknown) {
  if (!isRecord(value) || typeof value.on !== "boolean") return null;
  if (!value.on) return { on: false, by: null, since: null };
  return typeof value.by === "string" &&
    typeof value.since === "string" &&
    Number.isFinite(Date.parse(value.since))
    ? { on: true, by: value.by, since: value.since }
    : null;
}

export function minutesLeft(until: string | null, now: number): number {
  return until ? Math.max(0, Math.ceil((Date.parse(until) - now) / 60_000)) : 0;
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
