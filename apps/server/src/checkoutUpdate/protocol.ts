/**
 * Messages between a T3 server run from a git checkout and the supervisor that
 * runs it (`apps/server/scripts/checkout-supervisor.ts`), over Node's IPC
 * channel. Plain types and guards only: the supervisor runs outside the
 * server's runtime and imports this file directly.
 *
 * @module checkoutUpdate/protocol
 */

/** Set by the supervisor on the server it starts. */
export const CHECKOUT_SUPERVISOR_ENV = "T3CODE_CHECKOUT_SUPERVISOR";

export interface CheckoutCommit {
  readonly commit: string;
  /** The commit's first line. */
  readonly subject: string;
}

export type CheckoutUpdatePhase =
  | "idle"
  | "checking"
  | "installing"
  | "building"
  | "restarting"
  | "failed";

export interface CheckoutUpdateOutcome {
  readonly from: string;
  readonly to: string;
  readonly status: "updated" | "rolled-back";
  readonly reason: string | null;
}

/** What the supervisor knows, sent whenever it changes. */
export interface CheckoutUpdateSnapshot {
  readonly running: CheckoutCommit;
  /** The newest commit of the branch the supervisor follows, when it is not the running one. */
  readonly available: (CheckoutCommit & { readonly behind: number }) | null;
  readonly phase: CheckoutUpdatePhase;
  readonly message: string | null;
  readonly checkedAt: string | null;
  /** The last update this supervisor made, so a restarted server can say how it went. */
  readonly lastOutcome: CheckoutUpdateOutcome | null;
}

export type SupervisorMessage =
  | { readonly type: "t3-checkout.state"; readonly state: CheckoutUpdateSnapshot }
  /** Mark running turns to continue: the server is about to be stopped. */
  | { readonly type: "t3-checkout.prepare" };

export type ServerMessage =
  /** Asks for the state; sent once the server can take requests. */
  | { readonly type: "t3-checkout.ready" }
  | { readonly type: "t3-checkout.check" }
  | { readonly type: "t3-checkout.update" }
  | { readonly type: "t3-checkout.preparation-failed" }
  | { readonly type: "t3-checkout.prepared"; readonly threads: number };

const typeOf = (value: unknown): string | null =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string"
    ? (value as { type: string }).type
    : null;

export function isServerMessage(value: unknown): value is ServerMessage {
  const type = typeOf(value);
  return (
    type === "t3-checkout.ready" ||
    type === "t3-checkout.check" ||
    type === "t3-checkout.update" ||
    type === "t3-checkout.prepared" ||
    type === "t3-checkout.preparation-failed"
  );
}

export function isSupervisorMessage(value: unknown): value is SupervisorMessage {
  const type = typeOf(value);
  return type === "t3-checkout.state" || type === "t3-checkout.prepare";
}
