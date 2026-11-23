// Relay engine-owned payloads as JSON; type only the state T3 stores or acts on.
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ModelSelection } from "./modelSelection.ts";

/** What a conversation does when a seat's model has reached its usage limit. */
export const DeliveryLimitedSeatPolicy = Schema.Literals(["swap", "ask", "skip"]);
export type DeliveryLimitedSeatPolicy = typeof DeliveryLimitedSeatPolicy.Type;

export const DeliveryOrchestrationConfig = Schema.Struct({
  participants: Schema.Array(
    Schema.Struct({
      seat: TrimmedNonEmptyString,
      role: TrimmedNonEmptyString,
      modelSelection: ModelSelection,
      /** This participant's own access. Absent means the conversation's. */
      access: Schema.optional(Schema.Literals(["read-only", "approval-required", "full-access"])),
      /** A person chose this seat's model by hand, so it is never swapped without asking. */
      picked: Schema.optional(Schema.Boolean),
      /** What the seat does in its team. A QA seat never stands in on a builder seat's model. */
      duty: Schema.optional(Schema.Literals(["build", "qa"])),
      /** What a person agreed the seat runs on while its own model is limited. */
      substitute: Schema.optional(ModelSelection),
    }),
  ).check(Schema.isMinLength(2), Schema.isMaxLength(12)),
  /** When participants critique each other. Absent means the conversation's first message only. */
  critique: Schema.optional(Schema.Literals(["first", "always", "never"])),
  /** When a seat is limited. Absent means swap automatically. Read at the start of each turn. */
  limitedSeat: Schema.optional(DeliveryLimitedSeatPolicy),
  /** The access participants run with. Absent means read-only: what would change something is declined. */
  access: Schema.optional(Schema.Literals(["approval-required", "full-access"])),
  /** The team participants take their roles from, when the conversation itself is bound to none. */
  team: Schema.optional(TrimmedNonEmptyString),
});
export type DeliveryOrchestrationConfig = typeof DeliveryOrchestrationConfig.Type;

/** The access one seat joins with: its own, else the conversation's, else read-only. */
export const deliveryParticipantAccess = (
  lineup: Pick<DeliveryOrchestrationConfig, "access" | "participants">,
  seat: string,
) => lineup.participants.find((item) => item.seat === seat)?.access ?? lineup.access ?? "read-only";

export const deliveryLimitedSeatPolicy = (
  lineup: Pick<DeliveryOrchestrationConfig, "limitedSeat">,
): DeliveryLimitedSeatPolicy => lineup.limitedSeat ?? "swap";

/**
 * The team a conversation was switched away from, so one click brings it back.
 * The lead model is what the thread itself ran while the team was on; restoring
 * the team also points the thread back at it.
 */
export const DeliveryRememberedLineup = Schema.Struct({
  orchestration: DeliveryOrchestrationConfig,
  leadModelSelection: Schema.optional(ModelSelection),
});
export type DeliveryRememberedLineup = typeof DeliveryRememberedLineup.Type;

export const DELIVERY_DEFAULT_TEAM = "development";

export const DeliveryReleaseChannel = Schema.Literals(["dev", "qa", "main"]);
export type DeliveryReleaseChannel = typeof DeliveryReleaseChannel.Type;

const DeliveryCommit = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));
const DeliveryCodeVersion = Schema.Struct({
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  commit: Schema.NullOr(DeliveryCommit),
  changed: Schema.Boolean,
});

export const DeliveryEngineCapabilities = Schema.Struct({
  launcherLifecycle: Schema.Boolean,
});

export const DeliveryEngineLifecycleReceipt = Schema.Struct({
  accepted: Schema.Literal(true),
  id: TrimmedNonEmptyString,
  action: Schema.Literals(["stop", "restart"]),
});

export const DeliveryEngineCheckout = Schema.Struct({
  known: Schema.Boolean,
  behind: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  upstream: Schema.NullOr(Schema.String),
  fetchedAt: Schema.NullOr(Schema.String),
  text: Schema.String,
});

export const DeliveryEngineVersions = Schema.Struct({
  mainCheck: Schema.optional(
    Schema.NullOr(Schema.Struct({ at: Schema.String, reason: Schema.String })),
  ),
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

export const DeliveryNativeBuildStepInput = Schema.Struct({
  attemptId: TrimmedNonEmptyString.check(Schema.isPattern(/^att-[A-Za-z0-9-]+$/)),
});
export const DeliveryNativeBuildStepResult = Schema.Struct({
  attemptId: Schema.String,
  state: Schema.String,
  taskId: Schema.NullOr(Schema.String),
  next: Schema.optional(Schema.String),
});

const DeliverySeatThread = Schema.Struct({
  environmentId: Schema.optional(Schema.NullOr(Schema.String)),
  threadId: Schema.optional(Schema.NullOr(Schema.String)),
});
const DeliveryQaVerdict = Schema.Literals(["pass", "fail", "blocked"]);
const DeliveryAcceptanceIndex = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

export const DeliveryQaReceipt = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Number)),
  task: Schema.optional(Schema.NullOr(Schema.String)),
  run: Schema.optional(Schema.NullOr(Schema.String)),
  seat: Schema.optional(Schema.NullOr(Schema.String)),
  seatThread: Schema.optional(Schema.NullOr(DeliverySeatThread)),
  acceptance: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        index: Schema.optional(Schema.NullOr(DeliveryAcceptanceIndex)),
        hash: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  verdict: Schema.optional(Schema.NullOr(DeliveryQaVerdict)),
  evidence: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  modelSource: Schema.optional(Schema.NullOr(Schema.Literals(["attested", "picked", "requested"]))),
  independenceChecked: Schema.optional(Schema.NullOr(Schema.Boolean)),
  filedBy: Schema.optional(Schema.NullOr(Schema.String)),
  filedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

export const DeliverySeatHandoff = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Number)),
  run: Schema.optional(Schema.NullOr(Schema.String)),
  stage: Schema.optional(Schema.NullOr(Schema.Literals(["build", "review", "qa"]))),
  seat: Schema.optional(Schema.NullOr(Schema.String)),
  seatThread: Schema.optional(Schema.NullOr(DeliverySeatThread)),
  state: Schema.optional(Schema.NullOr(Schema.Literals(["handed", "delivered", "fallen-back"]))),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  setBy: Schema.optional(Schema.NullOr(Schema.String)),
  setAt: Schema.optional(Schema.NullOr(Schema.String)),
});

export const DeliverySeatAttestation = Schema.Struct({
  ...DeliverySeatThread.fields,
  run: Schema.optional(Schema.NullOr(Schema.String)),
  seat: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  harness: Schema.optional(Schema.NullOr(Schema.String)),
  setBy: Schema.optional(Schema.NullOr(Schema.String)),
  setAt: Schema.optional(Schema.NullOr(Schema.String)),
});

export const DeliverySeatHandoffInput = Schema.Struct({
  stage: Schema.Literal("qa"),
  seat: Schema.optional(Schema.String),
});
export const DeliverySeatHandoffResult = Schema.Struct({
  handoff: DeliverySeatHandoff,
  state: Schema.Literals(["working", "delivered", "fallen-back"]),
  next: Schema.optional(Schema.String),
});

export const DeliveryQaReceiptInput = Schema.Struct({
  acceptanceIndex: DeliveryAcceptanceIndex.annotate({ description: "Zero-based." }),
  verdict: DeliveryQaVerdict,
  // The engine validates each ref and refuses a bad one by field.
  evidence: Schema.Array(Schema.String),
});
export const DeliveryQaReceiptResult = Schema.Struct({
  qaReceipt: DeliveryQaReceipt,
  unchanged: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

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
  orchestration: Schema.optional(DeliveryOrchestrationConfig),
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
  orchestration: Schema.optional(DeliveryOrchestrationConfig),
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
  orchestration: Schema.optional(DeliveryOrchestrationConfig),
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
  /** Who joins the next message. Absent for an ordinary conversation. */
  lineup: Schema.optional(DeliveryOrchestrationConfig),
  /** The team this conversation most recently switched away from, if any. */
  rememberedLineup: Schema.optional(DeliveryRememberedLineup),
});
export type DeliveryThreadState = typeof DeliveryThreadState.Type;

/**
 * The archived conversations of board tasks. A task that ended (deleted, its project removed, or
 * held by another conversation) leaves its thread archived, and no thread list shows it: this is
 * how the board reaches them.
 */
export const DeliveryArchivedBoardThreads = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      projectId: ProjectId,
      title: Schema.String,
      archivedAt: Schema.String,
      /** The board and the task the thread was made for. */
      board: Schema.String,
      taskId: Schema.String,
      /**
       * How the task stands in the engine. Only an `open` task can take the thread back, so only
       * its thread is offered a restore: a restored thread of any other is archived again.
       * `held` is a task another conversation holds or that moved to another machine; `unknown`
       * is an engine that did not answer.
       */
      task: Schema.Literals(["open", "held", "deleted", "unknown"]),
    }),
  ),
});
export type DeliveryArchivedBoardThreads = typeof DeliveryArchivedBoardThreads.Type;

/**
 * A board task whose conversation is linked to a pull request or an issue. Its thread is in no
 * list, so it is shown as the task and opens the task view: the row carries no thread id.
 */
export const LinkedBoardTask = Schema.Struct({
  board: Schema.String,
  taskId: Schema.String,
  /** The engine's title, or the one the thread was made with when the engine has no such task. */
  title: Schema.String,
  /** The task ended (deleted, moved for good, its project removed): its conversation is archived. */
  ended: Schema.Boolean,
});
export type LinkedBoardTask = typeof LinkedBoardTask.Type;

/** Replaces who joins a conversation from its next message on; null makes it an ordinary one. */
export const DeliverySetThreadLineupInput = Schema.Struct({
  threadId: ThreadId,
  orchestration: Schema.NullOr(DeliveryOrchestrationConfig),
  /**
   * What the thread runs now, recorded with the team being switched away from so
   * restoring the team can point the thread back at its lead model.
   */
  rememberLeadModelSelection: Schema.optional(ModelSelection),
});
export type DeliverySetThreadLineupInput = typeof DeliverySetThreadLineupInput.Type;

export const DeliveryThreadBindingInput = Schema.Struct({ threadId: ThreadId });

/** A seat, or the lead, whose model has reached its usage limit, and what could stand in. */
export const DeliveryLimitedSeatNotice = Schema.Struct({
  /** The seat's name; null for the conversation's lead. */
  seat: Schema.NullOr(TrimmedNonEmptyString),
  limited: Schema.Struct({
    instanceId: ProviderInstanceId,
    model: TrimmedNonEmptyString,
    resetAt: Schema.NullOr(IsoDateTime),
  }),
  /**
   * `offered`: one click swaps to `substitute`. `none-free`: no favorite is free, so the seat
   * waits. `swapped`: `substitute` stands in, for a lead in the thread `continuedIn`.
   */
  state: Schema.Literals(["offered", "none-free", "swapped"]),
  /** The first free favorite, or the model that stands in. Null when none is free. */
  substitute: Schema.NullOr(ModelSelection),
  /** The thread a limited lead was handed on to. */
  continuedIn: Schema.optional(ThreadId),
});
export type DeliveryLimitedSeatNotice = typeof DeliveryLimitedSeatNotice.Type;

export const DeliveryLimitedSeatStatus = Schema.Struct({
  /** Null where this setting does not govern: an ordinary chat, or a board task's conversation. */
  policy: Schema.NullOr(DeliveryLimitedSeatPolicy),
  notices: Schema.Array(DeliveryLimitedSeatNotice),
});
export type DeliveryLimitedSeatStatus = typeof DeliveryLimitedSeatStatus.Type;

/** Swaps a limited seat, or the lead when `seat` is null, to a favorite the status offered. */
export const DeliveryLimitedSeatSwapInput = Schema.Struct({
  threadId: ThreadId,
  seat: Schema.NullOr(TrimmedNonEmptyString),
  modelSelection: ModelSelection,
});
export type DeliveryLimitedSeatSwapInput = typeof DeliveryLimitedSeatSwapInput.Type;

export const DeliveryLimitedSeatSwapResult = Schema.Struct({
  /** The thread the conversation continues in, when its lead was handed on. */
  continuedIn: Schema.NullOr(ThreadId),
});
export type DeliveryLimitedSeatSwapResult = typeof DeliveryLimitedSeatSwapResult.Type;
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
  antigravity: "agy",
};
