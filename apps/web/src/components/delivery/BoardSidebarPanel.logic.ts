import { boardTaskIsDone } from "@t3tools/client-runtime/board-task-in-play";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { waitKindsOf } from "../../lib/boardLaneCards";
import { BOARD_LANE, boardLaneOf } from "../../lib/boardLanes";
import { seatsAtWork, type DeliveryCard, type TaskBrief } from "../../lib/delivery";
import { matchesCard, type BoardFilters } from "../../lib/deliveryBoard";

/** The column's groups, in the order they show. */
export const PANEL_GROUPS = ["waiting", "working", "chats", "drafts", "open", "done"] as const;
export type PanelGroup = (typeof PANEL_GROUPS)[number];

/**
 * What the column lists. On the board, the board's filters narrow it. While a task is open the
 * column is a switcher: its own search narrows it, and the board's filters neither show nor apply,
 * so the board still has them when the person goes back.
 */
export function panelCards(
  cards: ReadonlyArray<DeliveryCard>,
  filters: BoardFilters,
  switching: boolean,
): ReadonlyArray<DeliveryCard> {
  return switching ? cards : cards.filter((card) => matchesCard(card, { ...filters, q: "" }));
}

const groupOf = (card: DeliveryCard): PanelGroup => {
  if (boardTaskIsDone(card)) return "done";
  if (card.lane === "draft") return "drafts";
  if (card.lane === "chat") return "chats";
  if (card.waitingOn === "person") return "waiting";
  // Being worked on: a seat is at work. A card whose seats are all held waits with the rest.
  return seatsAtWork(card).length > 0 ? "working" : "open";
};

/** The cards by group. Done keeps its last twenty. */
export function panelGroups(
  cards: ReadonlyArray<DeliveryCard>,
): Readonly<Record<PanelGroup, ReadonlyArray<DeliveryCard>>> {
  const groups: Record<PanelGroup, DeliveryCard[]> = {
    waiting: [],
    working: [],
    chats: [],
    drafts: [],
    open: [],
    done: [],
  };
  for (const card of cards) groups[groupOf(card)].push(card);
  return { ...groups, done: groups.done.slice(0, 20) };
}

/** The open task and what the switcher nests with it, all from the board's own read. */
export interface SwitcherFamily {
  readonly open: DeliveryCard;
  readonly parent: TaskBrief | null;
  /** Its current parts and QA follow-ups. */
  readonly children: ReadonlyArray<TaskBrief>;
  /** The seats of its conversation that have one; a seat with none has no row. */
  readonly seats: ReadonlyArray<{
    readonly seat: string;
    readonly activity: string;
    readonly thread: ScopedThreadRef;
  }>;
}

export type SwitcherRow =
  | {
      readonly kind: "task";
      readonly brief: TaskBrief;
      /** The board's card for the task, when it was read. */
      readonly card: DeliveryCard | null;
      /** The needs-you dot. */
      readonly waits: boolean;
      readonly depth: 0 | 1 | 2;
      readonly current: boolean;
    }
  | {
      readonly kind: "seat";
      readonly seat: string;
      readonly activity: string;
      readonly thread: ScopedThreadRef;
      readonly depth: 1 | 2;
    };

const briefOf = (card: DeliveryCard): TaskBrief => ({
  id: card.id,
  number: card.number,
  title: card.title,
  state: card.state,
  lane: card.lane,
});

/**
 * A task's row. A task known only by its brief, such as a part, which is off the board while its
 * whole is on it, waits on you when its lane is the board's one lane that does.
 */
export const taskRowOf = (
  brief: TaskBrief,
  card: DeliveryCard | null,
  depth: 0 | 1 | 2,
  current: boolean,
): SwitcherRow => ({
  kind: "task",
  brief,
  card,
  waits: card
    ? waitKindsOf(card).length > 0
    : boardLaneOf(brief.lane ?? "") === BOARD_LANE.needsDecision,
  depth,
  current,
});

/**
 * The switcher's rows by group, each task listed once. The open task's family sits in its
 * root's group: under the root, its parent if it has one, then the open task, its current child
 * tasks and its seat conversations, one level deeper each. A root the list did not read is shown
 * from what the open task says of it, at the head of the open task's group.
 */
export function switcherGroups(
  cards: ReadonlyArray<DeliveryCard>,
  family: SwitcherFamily | null,
): Readonly<Record<PanelGroup, ReadonlyArray<SwitcherRow>>> {
  // The open task's own read has its card when the list does not, as for a part.
  const byId = new Map([
    ...(family ? [[family.open.id, family.open] as const] : []),
    ...cards.map((card) => [card.id, card] as const),
  ]);
  const taskRow = (brief: TaskBrief, depth: 0 | 1 | 2): SwitcherRow =>
    taskRowOf(brief, byId.get(brief.id) ?? null, depth, family?.open.id === brief.id);
  const nested = new Set(
    family ? [...(family.parent ? [family.open.id] : []), ...family.children.map((c) => c.id)] : [],
  );
  const groups = panelGroups(cards.filter((card) => !nested.has(card.id)));
  const rows = Object.fromEntries(
    PANEL_GROUPS.map((group) => [group, groups[group].map((card) => taskRow(briefOf(card), 0))]),
  ) as Record<PanelGroup, SwitcherRow[]>;
  if (!family) return rows;

  const rootId = family.parent?.id ?? family.open.id;
  const under: 1 | 2 = family.parent ? 2 : 1;
  const familyRows: SwitcherRow[] = [
    ...(family.parent ? [taskRow(briefOf(family.open), 1)] : []),
    ...family.children.map((child) => taskRow(child, under)),
    ...family.seats.map((seat) => ({ kind: "seat" as const, ...seat, depth: under })),
  ];
  for (const group of PANEL_GROUPS) {
    const at = rows[group].findIndex((row) => row.kind === "task" && row.brief.id === rootId);
    if (at >= 0) {
      rows[group].splice(at + 1, 0, ...familyRows);
      return rows;
    }
  }
  const root = family.parent ?? briefOf(family.open);
  rows[groupOf(family.open)].unshift(taskRow(root, 0), ...familyRows);
  return rows;
}
