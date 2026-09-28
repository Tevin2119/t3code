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
export const DeliveryThreadBinding = Schema.Struct({
  threadId: ThreadId,
  /** The engine's session id, used to fetch this thread's instructions and tools. */
  session: TrimmedNonEmptyString,
  team: TrimmedNonEmptyString,
  role: TrimmedNonEmptyString,
  seat: TrimmedNonEmptyString,
  /** The engine's name for the harness, e.g. `claude` or `dsh`. */
  harness: TrimmedNonEmptyString,
  /** `team@revision#digest`, as written on the engine's receipt. */
  configuration: TrimmedNonEmptyString,
  requestedModel: Schema.NullOr(Schema.String),
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

export const DeliveryThreadBindingInput = Schema.Struct({ threadId: ThreadId });
export type DeliveryThreadBindingInput = typeof DeliveryThreadBindingInput.Type;

export class DeliveryError extends Schema.TaggedError<DeliveryError>()("DeliveryError", {
  reason: Schema.Literals(["disabled", "unreachable", "refused", "invalid", "unsupportedHarness"]),
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
