import type {
  BoardDeploymentLink,
  DeliveryDiscoveryDiagnostic,
  MergePermissionView,
} from "@t3tools/contracts";
import {
  deliveryFailureDiagnostic,
  type DeliveryFailure,
} from "@t3tools/shared/deliveryDiagnostics";

import { taskDeploymentStatus } from "./boardDelivery";
import type { DeliveryCard, DeliveryTarget } from "./delivery";

/**
 * What became of a card's approved change, as the engine reports it. Every field is copied
 * from the card; nothing here is a summary or a guess. Null means there is no publication,
 * and the card shows nothing for it.
 */
export type CardPublicationFact =
  | {
      readonly kind: "deployed";
      readonly project: string;
      readonly environment: string | null;
      readonly pullRequest: { readonly number: number; readonly url: string };
      // Reported by the deployment once the engine sends them; absent until then.
      readonly previewUrl: string | null;
      readonly deploymentId: string | null;
      readonly logsUrl: string | null;
    }
  | {
      readonly kind: "merged";
      /** The merge commit the repository host reported; null when it has not reported one. */
      readonly mergeCommit: string | null;
      readonly pullRequest: { readonly number: number; readonly url: string } | null;
    }
  | { readonly kind: "pull-request"; readonly number: number; readonly url: string }
  /** Pushing, pushed, closed or failed: the engine's state, shown as it is. */
  | { readonly kind: "publication"; readonly state: string };

export function cardPublicationFact(
  card: Pick<DeliveryCard, "publication" | "deployment" | "run">,
): CardPublicationFact | null {
  const current = card.deployment?.current;
  // Deployed only on the engine's runtime-verified live state, for this card's own run.
  if (current && current.run === card.run?.id && taskDeploymentStatus(current).state === "live")
    return {
      kind: "deployed",
      project: current.project?.title ?? current.projectId,
      environment: current.project?.environment ?? null,
      pullRequest: current.pullRequest,
      previewUrl: current.previewUrl ?? null,
      deploymentId: current.deploymentId ?? null,
      logsUrl: current.logsUrl ?? null,
    };
  const publication = card.publication;
  if (!publication) return null;
  if (publication.state === "merged")
    return {
      kind: "merged",
      mergeCommit: publication.mergeCommit ?? publication.mergeExecution?.mergeCommit ?? null,
      pullRequest: publication.pullRequest,
    };
  if (publication.state === "pr-open" && publication.pullRequest)
    return { kind: "pull-request", ...publication.pullRequest };
  return publication.state ? { kind: "publication", state: publication.state } : null;
}

/** Whether automatic merge is off, on but blocked, or on and eligible, and who said so. */
export type CardMergePermissionFact =
  | {
      readonly kind: "off";
      /** `fallback` means nothing was set at any layer. */
      readonly source: MergePermissionView["source"];
      readonly sourceId: string | null;
    }
  | { readonly kind: "not-eligible"; readonly blockingReason: string | null }
  | { readonly kind: "eligible" }
  | { readonly kind: "problem"; readonly problem: string };

export function cardMergePermissionFact(
  policy: MergePermissionView | null | undefined,
): CardMergePermissionFact | null {
  if (!policy) return null;
  if (policy.problem) return { kind: "problem", problem: policy.problem };
  if (policy.resolved === "off")
    return { kind: "off", source: policy.source, sourceId: policy.sourceId };
  if (!policy.eligible) return { kind: "not-eligible", blockingReason: policy.blockingReason };
  return { kind: "eligible" };
}

/** The durable merge states of MERGE-EXECUTION.md, in the groups a card shows them in. */
const MERGE_EXECUTION_GROUP = {
  "not-evaluated": "waiting",
  queued: "in-progress",
  intent: "in-progress",
  blocked: "failed",
  uncertain: "uncertain",
} as const satisfies Record<string, string>;

export type CardMergeExecutionFact = {
  readonly group: (typeof MERGE_EXECUTION_GROUP)[keyof typeof MERGE_EXECUTION_GROUP] | "unknown";
  readonly state: string;
  readonly reason: string | null;
};

/**
 * The engine's own merge of an open pull request. Merged and observed are the Merged fact
 * instead; a blocked merge whose reason is the permission's own blocking reason says nothing
 * the permission line has not said.
 */
export function cardMergeExecutionFact(
  card: Pick<DeliveryCard, "publication" | "mergePermission">,
): CardMergeExecutionFact | null {
  const execution = card.publication?.mergeExecution;
  if (!execution || execution.state === "merged" || execution.state === "observed") return null;
  if (
    execution.state === "blocked" &&
    execution.reason !== null &&
    execution.reason === card.mergePermission?.blockingReason
  )
    return null;
  const group =
    MERGE_EXECUTION_GROUP[execution.state as keyof typeof MERGE_EXECUTION_GROUP] ?? "unknown";
  return { group, state: execution.state, reason: execution.reason };
}

/** A board's deployment link as the board shows it. */
export type BoardDeploymentLinkView =
  /** An engine that does not report links. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "unlinked"; readonly canLink: boolean; readonly needsName: boolean }
  | {
      readonly kind: "linked";
      readonly project: string;
      readonly environment: string | null;
      readonly by: string | null;
      readonly at: string | null;
    }
  /** The engine's problem text, unchanged. */
  | { readonly kind: "invalid"; readonly problem: string | null };

/**
 * The engine refuses a link without a named person, so the link action is offered only when
 * this connection may act and a name is set: never a button that will just be refused.
 */
export function boardDeploymentLinkView(
  link: BoardDeploymentLink | null | undefined,
  input: { readonly person: string; readonly allowed: boolean },
): BoardDeploymentLinkView {
  if (!link) return { kind: "unavailable" };
  // A linked board the engine reports a problem for is shown with that problem, never as fine.
  if (link.state === "invalid" || (link.state === "linked" && link.problem))
    return { kind: "invalid", problem: link.problem };
  if (link.state === "linked" && link.deploymentProjectId)
    return {
      kind: "linked",
      project: link.project?.title ?? link.deploymentProjectId,
      environment: link.project?.environment ?? null,
      by: link.by,
      at: link.at,
    };
  const named = input.person.trim().length > 0;
  return { kind: "unlinked", canLink: input.allowed && named, needsName: !named };
}

/**
 * Why a board cannot have a deployment linked, read from the target the engine reported. An
 * unregistered repository has a name and no folder; a board with no repository or base branch,
 * or one whose branch cannot be used, has no target. The engine's problem text goes with it.
 */
export function boardTargetDiagnostic(target: DeliveryTarget | null): {
  readonly code: "missing-target" | "unregistered-repository";
  readonly problem: string | null;
} | null {
  if (!target) return { code: "missing-target", problem: null };
  if (target.repository && !target.path)
    return { code: "unregistered-repository", problem: target.problem };
  if (!target.repository || !target.base || !target.ok)
    return { code: "missing-target", problem: target.problem };
  return null;
}

/**
 * The diagnostic for a failed engine read on a board screen. A task read the engine answers
 * with 404 is a task that is not there; everything else is named as discovery names it.
 */
export function deliveryReadDiagnostic(
  failure: unknown,
  input: { readonly task?: boolean } = {},
): DeliveryDiscoveryDiagnostic {
  const value =
    typeof failure === "object" && failure !== null ? (failure as DeliveryFailure) : null;
  if (input.task && value?._tag === "DeliveryError" && value.status === 404)
    return "task-not-found";
  return deliveryFailureDiagnostic(value);
}
