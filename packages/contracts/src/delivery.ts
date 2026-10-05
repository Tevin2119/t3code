/**
 * Delivery - the wire contract between clients and a team delivery engine.
 *
 * The engine is a separate local service that owns teams, task flow and
 * approvals. T3 Code is a window onto it: the server relays requests and
 * never decides anything the engine owns. Engine payloads are relayed as
 * untyped JSON so the engine can evolve without a contract change here;
 * only what T3 Code itself stores or acts on is typed.
 *
 * @module delivery
 */
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DELIVERY_DEFAULT_TEAM = "development";
export const DELIVERY_DEFAULT_ENGINE_URL = "http://127.0.0.1:4320";

export const DeliveryReleaseChannel = Schema.Literals(["dev", "qa", "main"]);
export type DeliveryReleaseChannel = typeof DeliveryReleaseChannel.Type;

const DeliveryCommit = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));
const DeliveryCodeVersion = Schema.Struct({
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  commit: Schema.NullOr(DeliveryCommit),
  changed: Schema.Boolean,
});

export const DeliveryEngineVersions = Schema.Struct({
  channel: DeliveryReleaseChannel,
  running: Schema.NullOr(DeliveryCodeVersion),
  installed: Schema.NullOr(DeliveryCodeVersion),
  available: Schema.NullOr(Schema.Struct({ commit: DeliveryCommit, at: Schema.String })),
  updateAvailable: Schema.Boolean,
  restartRequired: Schema.Boolean,
  deferred: Schema.Boolean,
  managed: Schema.Boolean,
  pinned: Schema.Boolean,
  problem: Schema.NullOr(Schema.String),
  update: Schema.NullOr(
    Schema.Struct({
      id: Schema.NullOr(Schema.String),
      phase: Schema.Literals(["draining", "snapshotting", "starting", "complete", "failed"]),
      channel: DeliveryReleaseChannel,
      commit: Schema.NullOr(DeliveryCommit),
      at: Schema.String,
      snapshot: Schema.optional(Schema.NullOr(Schema.String)),
      problem: Schema.optional(Schema.String),
    }),
  ),
});
export type DeliveryEngineVersions = typeof DeliveryEngineVersions.Type;

export const DeliveryEngineUpdateReceipt = Schema.Struct({
  accepted: Schema.Literal(true),
  id: TrimmedNonEmptyString,
  commit: DeliveryCommit,
  channel: DeliveryReleaseChannel,
});

/** Only engine API paths are relayed; anything else is rejected before a request is made. */
export const DeliveryPath = TrimmedNonEmptyString.check(
  Schema.isPattern(/^\/api\/[A-Za-z0-9_\-/]+(\?[A-Za-z0-9_\-=&%.:+~]*)?$/),
  Schema.isMaxLength(512),
);
export type DeliveryPath = typeof DeliveryPath.Type;

export const DeliveryReadInput = Schema.Struct({ path: DeliveryPath });
export type DeliveryReadInput = typeof DeliveryReadInput.Type;

export const DeliveryActInput = Schema.Struct({
  path: DeliveryPath,
  /** Relayed as given. An approval key in here is passed through and never stored. */
  body: Schema.optional(Schema.Unknown),
});
export type DeliveryActInput = typeof DeliveryActInput.Type;

export const DeliveryResponse = Schema.Struct({
  /** When the server asked the engine, so clients can show how stale a reading is. */
  readAt: Schema.String,
  body: Schema.Unknown,
});
export type DeliveryResponse = typeof DeliveryResponse.Type;

/**
 * What a thread was started with. Pinned at bind time: a thread keeps its
 * team, role and configuration revision even when the team is edited later.
 */
/** What the seat of a thread runs on, which the thread takes over unless a person chooses otherwise. */
export const DeliverySeatSettings = Schema.Struct({
  harness: TrimmedNonEmptyString,
  model: Schema.NullOr(Schema.String),
  reasoning: Schema.NullOr(Schema.String),
  access: Schema.NullOr(Schema.String),
  /** Where the values come from: the team's definition, or the defaults a person saved. */
  from: Schema.String,
});
export type DeliverySeatSettings = typeof DeliverySeatSettings.Type;

export const DeliveryThreadBinding = Schema.Struct({
  threadId: ThreadId,
  /** The engine's session id, used to fetch this thread's instructions and tools. */
  session: TrimmedNonEmptyString,
  team: TrimmedNonEmptyString,
  role: TrimmedNonEmptyString,
  seat: TrimmedNonEmptyString,
  /** The engine's name for the harness, e.g. `claude` or `dsh`. */
  harness: TrimmedNonEmptyString,
  /** T3 Code's driver kind the thread was bound with. A session on another driver is refused. */
  driver: TrimmedNonEmptyString,
  /** Root of the repository the thread was bound in. A session elsewhere is refused. */
  workspace: TrimmedNonEmptyString,
  /** `team@revision#digest`, as written on the engine's receipt. */
  configuration: TrimmedNonEmptyString,
  requestedModel: Schema.NullOr(Schema.String),
  /** Absent on a thread bound before seats carried their settings. */
  seatSettings: Schema.optional(DeliverySeatSettings),
  memoryScope: TrimmedNonEmptyString,
  tools: Schema.Array(Schema.String),
  project: Schema.String,
  boundAt: Schema.String,
});
export type DeliveryThreadBinding = typeof DeliveryThreadBinding.Type;

export const DeliveryBindThreadInput = Schema.Struct({
  threadId: ThreadId,
  team: TrimmedNonEmptyString,
  /** Required only when the harness can take more than one role in the team. */
  role: Schema.optional(TrimmedNonEmptyString),
  /** T3 Code's driver kind, e.g. `claudeAgent`. The server maps it to the engine's harness name. */
  driver: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
});
export type DeliveryBindThreadInput = typeof DeliveryBindThreadInput.Type;

/**
 * A team was chosen for the thread and its setup did not complete. Until it
 * does, or a person releases it, the thread cannot start a session: a failed
 * setup must never leave behind an ordinary thread that looks like a retry.
 */
export const DeliveryThreadPending = Schema.Struct({
  threadId: ThreadId,
  team: TrimmedNonEmptyString,
  role: Schema.NullOr(Schema.String),
  driver: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  since: Schema.String,
  /** Why the last attempt failed, or null while the first attempt is under way. */
  why: Schema.NullOr(Schema.String),
});
export type DeliveryThreadPending = typeof DeliveryThreadPending.Type;

export const DeliveryThreadState = Schema.Struct({
  binding: Schema.NullOr(DeliveryThreadBinding),
  pending: Schema.NullOr(DeliveryThreadPending),
});
export type DeliveryThreadState = typeof DeliveryThreadState.Type;

export const DeliveryThreadBindingInput = Schema.Struct({ threadId: ThreadId });
export type DeliveryThreadBindingInput = typeof DeliveryThreadBindingInput.Type;

export class DeliveryError extends Schema.TaggedError<DeliveryError>()("DeliveryError", {
  reason: Schema.Literals([
    "disabled",
    "unreachable",
    "refused",
    "invalid",
    "unsupportedHarness",
    /** The record of bound threads could not be read or written. */
    "storage",
    /** The session does not match what the thread was bound with. */
    "mismatch",
    /** A team was chosen and its setup has not completed. */
    "pending",
  ]),
  /** Stable, bounded description. For `refused` this is the engine's own reason. */
  detail: TrimmedNonEmptyString,
  /** The engine's HTTP status, when it answered. */
  status: Schema.optional(Schema.Number),
  /** The engine's answer when it refused, e.g. the roles to choose from. */
  body: Schema.optional(Schema.Unknown),
}) {
  override get message(): string {
    return `Delivery engine (${this.reason}): ${this.detail}`;
  }
}

/** T3 Code driver kind to the engine's harness name. A driver not listed has no team support. */
export const DELIVERY_HARNESS_BY_DRIVER: Readonly<Record<string, string>> = {
  claudeAgent: "claude",
  codex: "codex",
  opencode: "opencode",
  pi: "pi",
  kimi: "kimi",
  hermes: "hermes",
  deepseek: "dsh",
};
