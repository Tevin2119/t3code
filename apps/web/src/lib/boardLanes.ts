import { msg } from "gt-react";

import type { DeliveryCard, DeliveryLane } from "./delivery";

/**
 * The board's 11 lanes (BOARD-REVAMP-UI-SPEC section 5) and the table that puts the engine's
 * lanes into them. The ids `queue` and `in-work` are proposals, named only here. When the engine
 * sends these ids (build slice 6) each maps to itself, and this module is deleted with its calls.
 */
export const BOARD_LANE = {
  draft: "draft",
  chat: "chat",
  queue: "queue",
  inWork: "in-work",
  childWork: "child-work",
  needsDecision: "needs-decision",
  paused: "paused",
  approved: "approved",
  pullRequest: "pull-request",
  closedNotDone: "closed-not-done",
  completed: "completed",
} as const;

export type BoardLaneId = (typeof BOARD_LANE)[keyof typeof BOARD_LANE];

/** The lanes in the order the board shows them. Resolve a title with `useMessages()`. */
export const BOARD_LANES: ReadonlyArray<{ readonly id: BoardLaneId; readonly title: string }> = [
  { id: BOARD_LANE.draft, title: msg("Drafts") },
  { id: BOARD_LANE.chat, title: msg("Team chats") },
  {
    id: BOARD_LANE.queue,
    title: msg("Queue", { $context: "noun, a board lane of tasks waiting for a free slot" }),
  },
  {
    id: BOARD_LANE.inWork,
    title: msg("In work", { $context: "a board lane of tasks being worked on now" }),
  },
  { id: BOARD_LANE.childWork, title: msg("Waiting on child work") },
  { id: BOARD_LANE.needsDecision, title: msg("Waiting on you") },
  { id: BOARD_LANE.paused, title: msg("Paused or recovering") },
  { id: BOARD_LANE.approved, title: msg("Approved, not published") },
  { id: BOARD_LANE.pullRequest, title: msg("Pull request open") },
  { id: BOARD_LANE.closedNotDone, title: msg("Closed, not done") },
  { id: BOARD_LANE.completed, title: msg("Done", { $context: "a board lane of finished tasks" }) },
];

const KNOWN: ReadonlySet<string> = new Set(BOARD_LANES.map((lane) => lane.id));

/**
 * The engine's 17 lanes (`LANES` in its views.mjs; the spec counts 18) and where each goes.
 * `intake` and `ready` are both waiting for a slot; an unsubmitted intake card lands there too
 * and is given no place in line. The five run stages are one lane. `human-review` joins
 * `needs-decision`, the one lane that waits on a person.
 */
const BOARD_LANE_OF: Readonly<Record<string, BoardLaneId>> = {
  draft: BOARD_LANE.draft,
  chat: BOARD_LANE.chat,
  intake: BOARD_LANE.queue,
  ready: BOARD_LANE.queue,
  triage: BOARD_LANE.inWork,
  planning: BOARD_LANE.inWork,
  implementation: BOARD_LANE.inWork,
  validation: BOARD_LANE.inWork,
  rework: BOARD_LANE.inWork,
  "child-work": BOARD_LANE.childWork,
  "needs-decision": BOARD_LANE.needsDecision,
  "human-review": BOARD_LANE.needsDecision,
  paused: BOARD_LANE.paused,
  approved: BOARD_LANE.approved,
  "pull-request": BOARD_LANE.pullRequest,
  "closed-not-done": BOARD_LANE.closedNotDone,
  completed: BOARD_LANE.completed,
};

/** The board lane an engine lane belongs to. A lane this table does not know stands as itself. */
export const boardLaneOf = (lane: string | null | undefined): string =>
  BOARD_LANE_OF[lane ?? ""] ?? lane ?? "";

/**
 * The engine lanes a board lane holds, in the order a drop on it is tried: the first whose move
 * is not refused is the one asked for. A lane the table does not split is its own only choice.
 */
export function engineLanesOf(lane: string): ReadonlyArray<string> {
  const own = Object.entries(BOARD_LANE_OF)
    .filter(([, board]) => board === lane)
    .map(([engine]) => engine);
  if (lane === BOARD_LANE.queue) return ["ready", "intake"];
  if (lane === BOARD_LANE.inWork)
    return ["triage", "planning", "implementation", "validation", "rework"];
  return own.length > 0 ? own : [lane];
}

/** First for the next free slots, then the engine's order. */
const inLineOrder = (a: DeliveryCard, b: DeliveryCard) =>
  Number(b.first) - Number(a.first) || a.rank - b.rank;

/**
 * The engine's lanes as the board's. A lane is shown when the engine sent one of its sources, so
 * a view that picks columns still picks. Cards of a merged lane stand in the engine's order: by
 * rank, with the ones put first at the head of the queue. A lane the table does not know is kept
 * at the end rather than dropped, so a card is never lost to a lane this build has not heard of.
 */
export function regroupLanes(lanes: ReadonlyArray<DeliveryLane>): ReadonlyArray<DeliveryLane> {
  const groups = new Map<string, DeliveryLane[]>();
  for (const lane of lanes) {
    const id = boardLaneOf(lane.lane);
    const group = groups.get(id);
    if (group) group.push(lane);
    else groups.set(id, [lane]);
  }
  const order = [
    ...BOARD_LANES.map((lane) => lane.id).filter((id) => groups.has(id)),
    ...[...groups.keys()].filter((id) => !KNOWN.has(id)),
  ];
  return order.map((id) => {
    const sources = groups.get(id)!;
    const cards = sources.flatMap((source) => source.cards);
    return {
      lane: id,
      title: sources[0]!.title,
      cards:
        id === BOARD_LANE.queue
          ? cards.toSorted(inLineOrder)
          : sources.length > 1
            ? cards.toSorted((a, b) => a.rank - b.rank)
            : cards,
    };
  });
}

/** What a board lane is called, in the language in use; the engine's word for one this table lacks. */
export function boardLaneTitle(
  lane: string,
  resolve: (message: string) => string,
  fallback: string = lane,
): string {
  const entry = BOARD_LANES.find((item) => item.id === lane);
  return entry ? resolve(entry.title) : fallback;
}
