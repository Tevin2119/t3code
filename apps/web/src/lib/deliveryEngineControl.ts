import {
  DeliveryEngineCapabilities,
  DeliveryEngineCheckout,
  DeliveryEngineLifecycleReceipt,
  DeliveryEngineUpdateReceipt,
  DeliveryEngineVersions,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeCapabilities = Schema.decodeUnknownOption(DeliveryEngineCapabilities);
const decodeLifecycleReceipt = Schema.decodeUnknownOption(DeliveryEngineLifecycleReceipt);
const decodeCheckout = Schema.decodeUnknownOption(DeliveryEngineCheckout);
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
    launcherOwned:
      Option.getOrNull(decodeCapabilities(field("capabilities")))?.launcherLifecycle === true,
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
  return {
    on: true,
    by: typeof value.by === "string" && value.by.trim() ? value.by : null,
    since:
      typeof value.since === "string" && Number.isFinite(Date.parse(value.since))
        ? value.since
        : null,
  };
}

export function minutesLeft(until: string | null, now: number): number {
  return until ? Math.max(0, Math.ceil((Date.parse(until) - now) / 60_000)) : 0;
}

export function deliveryEngineDiagnostics(body: unknown) {
  const summary = parseDeliveryEngineHealth(body);
  const checkout = Option.getOrNull(
    decodeCheckout(
      typeof body === "object" && body !== null && "checkout" in body ? body.checkout : null,
    ),
  );
  const behind = checkout?.known && checkout.fetchedAt ? checkout.behind : null;
  return {
    checkout,
    freshness:
      behind === null
        ? "Behind upstream: unknown"
        : behind === 0
          ? `Checkout is 0 commits behind ${checkout?.upstream ?? "its upstream"} as of ${checkout?.fetchedAt}`
          : `Checkout is ${behind} commit${behind === 1 ? "" : "s"} behind ${checkout?.upstream ?? "its upstream"} as of ${checkout?.fetchedAt}`,
    summary,
  };
}

/** Allowlisted health facts only. Never serialize the raw health reply or approval input. */
export function deliveryEngineFixPrompt(
  body: unknown,
  reading?: {
    readonly reachable: boolean;
    readonly error: string | null;
    readonly readAt: string | null;
  },
) {
  const { summary, checkout, freshness } = deliveryEngineDiagnostics(body);
  const versions = summary.versions;
  return [
    "Diagnose and fix the PaperClip engine issue in this project. Inspect before editing.",
    "Do not stop, restart, install an update, or launch another engine without explicit approval.",
    "Preserve all tracked and untracked changes, including .worktrees. Do not infer that dirty paths are disposable.",
    reading?.reachable === false
      ? `Engine health unreachable: ${reading.error ?? "No health response"}. Last reading: ${reading.readAt ?? "never"}. The following snapshot may be stale.`
      : `Initial health snapshot (read at ${reading?.readAt ?? "unknown time"}):`,
    JSON.stringify(
      {
        launcherOwned: summary.launcherOwned,
        stopping: summary.stopping,
        profile: summary.profile,
        pid: summary.pid,
        commit: summary.commit,
        versions,
        checkout,
      },
      null,
      2,
    ),
    freshness,
    `Commit range to inspect: ${versions?.running?.commit ?? "unknown running commit"}..${versions?.available?.commit ?? versions?.installed?.commit ?? "unknown target commit"}`,
    `Latest main-check diagnostic: ${versions?.mainCheck?.reason ?? "Not reported"}`,
    "Health does not provide full failing-check output or dirty paths. Read the relevant engine check logs and git status in the selected project, report the failing output and commit-range diff before proposing a fix. Never include approval keys or credentials.",
  ].join("\n");
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

/**
 * What the engine needs a person for, or null: a failed update, a restart, a problem, or an
 * update that is ready and not put off. The board badge, the Engine button and the board's
 * update bar all read this one answer.
 */
export function engineAttention(versions: DeliveryEngineVersions | null): string | null {
  if (!versions) return null;
  if (versions.update?.phase === "failed")
    return "The last engine update failed. Open the engine to see why.";
  if (versions.restartRequired) return "The engine needs a restart to run its installed version.";
  if (versions.problem) return versions.problem;
  if (versions.updateAvailable && !versions.deferred) {
    return versions.available
      ? `Engine update ready: ${versions.available.commit.slice(0, 7)}.`
      : "An engine update is ready.";
  }
  return null;
}

export function deliveryUpdatePending(id: string | null, versions: DeliveryEngineVersions | null) {
  if (id === null) return false;
  const update = versions?.update;
  if (update?.id !== id) return true;
  if (update.phase === "failed") return false;
  return update.phase !== "complete" || versions?.running?.commit !== update.commit;
}

// CheckoutUpdate's phases and reload action describe T3 itself. Engine releases use
// drain/snapshot/start receipts and must never reload T3 or infer completion from its build.
export function deliveryEngineUpdateStatus(
  versions: DeliveryEngineVersions | null,
  id: string | null,
) {
  if (deliveryUpdatePending(id, versions)) {
    return {
      kind: "progress",
      text: "Update acceptance recorded. Waiting for matching engine health confirmation.",
    } as const;
  }
  if (!versions) return { kind: "unknown", text: "Release status is not reported." } as const;
  if (versions.problem || versions.update?.phase === "failed") {
    return {
      kind: "error",
      text:
        versions.problem ??
        versions.update?.problem ??
        "The engine update failed. Inspect diagnostics before retrying.",
    } as const;
  }
  if (versions.update && ["draining", "snapshotting", "starting"].includes(versions.update.phase)) {
    return {
      kind: "progress",
      text: `Engine update: ${versions.update.phase}. Completion is not confirmed.`,
    } as const;
  }
  if (versions.updateAvailable) {
    return {
      kind: "available",
      text: versions.deferred
        ? "Release update deferred. You can install it here later."
        : "A release update is available.",
    } as const;
  }
  return {
    kind: "idle",
    text: "No release update is currently offered. This does not mean the checkout is current.",
  } as const;
}

export async function controlDeliveryEngine(
  action: "start" | "stop" | "restart",
  operations: {
    readonly launcherOwned?: boolean;
    readonly lifecycle?: (action: "stop" | "restart") => Promise<unknown>;
    readonly start: () => Promise<void>;
  },
): Promise<void> {
  // Stop and restart require launcher ownership. Never stop before a terminal fallback.
  if (action !== "start") {
    if (operations.launcherOwned && operations.lifecycle) {
      const receipt = decodeLifecycleReceipt(await operations.lifecycle(action));
      if (Option.isNone(receipt) || receipt.value.action !== action) {
        throw new Error("Launcher acceptance was not confirmed. Inspect health before retrying.");
      }
      return;
    }
    throw new Error(
      "This engine does not advertise launcher-owned stop or restart. Nothing was stopped. Update the engine launcher to enable these controls.",
    );
  }
  await operations.start();
}
