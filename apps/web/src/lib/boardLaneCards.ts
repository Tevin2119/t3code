import { msg } from "gt-react";

import type { DeliveryCard } from "./delivery";

/**
 * What the lanes of the revamped board say about a card (BOARD-REVAMP-UI-SPEC section 5): the
 * stage a card in work is at, its place in the queue, and what kind of wait a person owes it.
 * Each reads only what the engine sent on the card. Nothing is estimated or worked out about
 * eligibility, and none of it offers an action: those come from the card's `actions` alone.
 */

/** The sections of the In work lane, in order. */
const WORK_STAGES = ["triage", "plan", "build", "checks", "review", "qa"] as const;
export type WorkStage = (typeof WORK_STAGES)[number];

/** A card in work whose stage the engine named in no way this client knows. */
const UNKNOWN_STAGE = "unknown" as const;
export type CardStage = WorkStage | typeof UNKNOWN_STAGE;

export const WORK_STAGE_TITLE: Readonly<Record<CardStage, string>> = {
  triage: msg("Triage", { $context: "a stage of a board task, where it is sorted and prepared" }),
  plan: msg("Plan", { $context: "noun, a stage of a board task where the plan is made" }),
  build: msg("Build", { $context: "noun, a stage of a board task where the work is built" }),
  checks: msg("Checks", { $context: "noun, a stage of a board task where tests and checks run" }),
  review: msg("Review", { $context: "noun, a stage of a board task where the work is reviewed" }),
  qa: msg("QA", { $context: "a stage of a board task: independent quality assurance" }),
  [UNKNOWN_STAGE]: msg("Stage not known", {
    $context: "heading for board tasks in work whose stage the engine did not report",
  }),
};

/**
 * The run stages the engine reports that are not one of the six, and the section each belongs in.
 * The stages of the other flows (research, produce, validate) stand where they do the same work.
 */
const STAGE_OF_RUN: Readonly<Record<string, WorkStage>> = {
  ...Object.fromEntries(WORK_STAGES.map((stage) => [stage, stage])),
  admit: "plan",
  research: "plan",
  setup: "build",
  produce: "build",
  validate: "checks",
  "final-review": "review",
  "human-acceptance": "review",
  approval: "review",
};

/** For a card with no run to read: the engine lane that put it in work says the stage. */
const STAGE_OF_LANE: Readonly<Record<string, WorkStage>> = {
  triage: "triage",
  planning: "plan",
  implementation: "build",
  validation: "qa",
  rework: "build",
};

/** The engine's section, with a run or lane fallback for older cards. */
export function workStageOf(card: Pick<DeliveryCard, "lane" | "run" | "inWorkStage">): CardStage {
  const reported = WORK_STAGES.find((stage) => stage === card.inWorkStage);
  if (reported) return reported;
  if (card.lane === "triage") return "triage";
  if (card.lane === "rework") return "build";
  // Neither the run nor the lane places it: no stage is made up for it.
  return STAGE_OF_RUN[card.run?.stage ?? ""] ?? STAGE_OF_LANE[card.lane] ?? UNKNOWN_STAGE;
}

/**
 * The cards of the In work lane in sections, in stage order; a stage with no card has no section.
 * Cards of no known stage come last in a section of their own, so none drops off the board.
 */
export function workSections<T extends Pick<DeliveryCard, "lane" | "run" | "inWorkStage">>(
  cards: ReadonlyArray<T>,
): ReadonlyArray<{ readonly stage: CardStage; readonly cards: ReadonlyArray<T> }> {
  return ([...WORK_STAGES, UNKNOWN_STAGE] satisfies ReadonlyArray<CardStage>)
    .map((stage) => ({
      stage,
      cards: cards.filter((card) => workStageOf(card) === stage),
    }))
    .filter((section) => section.cards.length > 0);
}

/**
 * A rework round, as a count on the card: `rounds` when the engine counts them, null with the
 * card in rework when it does not, and nothing when the card is not being reworked.
 */
export function reworkOf(
  card: Pick<DeliveryCard, "lane" | "reworkRounds">,
): { readonly rounds: number | null } | null {
  if (card.reworkRounds !== null && card.reworkRounds > 0) return { rounds: card.reworkRounds };
  return card.lane === "rework" ? { rounds: null } : null;
}

/**
 * Where each card of the queue stands in line, 1 first, from the order the lane holds them in
 * (first for the next slots, then the engine's rank). A card a person has not submitted is not in
 * line and has no place. The engine's own position, when it sends one (`card.queue`), wins.
 */
export function queuePlaces(
  cards: ReadonlyArray<Pick<DeliveryCard, "id" | "submitted" | "queue">>,
): ReadonlyMap<string, number> {
  const places = new Map<string, number>();
  let next = 1;
  for (const card of cards) {
    if (card.queue) {
      places.set(card.id, card.queue.position);
    } else if (card.submitted) {
      places.set(card.id, next);
    }
    if (card.submitted || card.queue) next += 1;
  }
  return places;
}

/** The kinds of wait on a person. A card can owe a person more than one. */
export type WaitKind =
  | "question"
  | "proposal"
  | "sign-off"
  | "plan"
  | "deliverables"
  | "decision"
  | "submit"
  | "resume"
  | "other";

type Waiting = Pick<
  DeliveryCard,
  | "lane"
  | "waitsOnPerson"
  | "questions"
  | "proposals"
  | "approveStands"
  | "actions"
  | "approvals"
  | "paused"
>;

/**
 * What a person owes a card, as kinds. `waitsOnPerson` is the engine's answer to whether anyone
 * waits; `questions`, `proposals`, `paused` and `actions` then name the wait. A sign-off is
 * `approve` offered with no approval standing; a plan to read is `deliver`. A draft is not a wait.
 */
export function waitKindsOf(card: Waiting): ReadonlyArray<WaitKind> {
  if (!card.waitsOnPerson || card.lane === "draft") return [];
  const kinds: WaitKind[] = [];
  if (card.questions > 0) kinds.push("question");
  if (card.proposals > 0) kinds.push("proposal");
  if (card.actions.includes("approve") && !card.approveStands) kinds.push("sign-off");
  if (card.actions.includes("deliver")) kinds.push("plan");
  if (card.actions.includes("accept-artifacts")) kinds.push("deliverables");
  if (card.paused?.needsPerson) kinds.push("decision");
  if (card.actions.includes("submit")) kinds.push("submit");
  if (card.actions.includes("resume")) kinds.push("resume");
  return kinds.length > 0 ? kinds : ["other"];
}

/**
 * What was said on a card, as the engine counts it: how many messages, how many of them new to
 * the person, and the last one's line. Null when nothing was said. Once the task's conversation
 * is mirrored (spec 6a, slice 5), its count and last summary line stand in for the engine log's.
 */
export function cardActivityOf(
  card: Pick<DeliveryCard, "messages" | "unread" | "last" | "conversation">,
): {
  readonly messages: number;
  readonly unread: number;
  readonly by: string | null;
  readonly text: string | null;
} | null {
  const mirror = card.conversation;
  if (mirror !== null && mirror.count > 0) {
    // A steer carries no excerpt: the card shows the count, never a person's words.
    return { messages: mirror.count, unread: card.unread, by: null, text: mirror.lastExcerpt };
  }
  if (card.messages <= 0 && card.unread <= 0 && !card.last?.text) return null;
  return {
    // The engine counts both; a count it sent smaller than the other is still not made up here.
    messages: card.messages,
    unread: card.unread,
    by: card.last?.text ? card.last.by || null : null,
    text: card.last?.text ? card.last.text : null,
  };
}

/**
 * What a lane of waiting cards owes in all: the open questions and the sign-offs, added up from
 * the same card fields `waitKindsOf` reads. A card that does not wait on a person adds nothing.
 */
export function laneWaitCounts(cards: ReadonlyArray<Waiting>): {
  readonly questions: number;
  readonly signOffs: number;
} {
  let questions = 0;
  let signOffs = 0;
  for (const card of cards) {
    const kinds = waitKindsOf(card);
    if (kinds.includes("question")) questions += card.questions;
    if (kinds.includes("sign-off")) signOffs += 1;
  }
  return { questions, signOffs };
}

/** Who has approved the task and still stands, for the sign-off line. */
export const standingApprovers = (card: Pick<DeliveryCard, "approvals">): ReadonlyArray<string> =>
  card.approvals
    .filter((approval) => approval.decision === "approve" && approval.stands)
    .map((approval) => approval.actor);
