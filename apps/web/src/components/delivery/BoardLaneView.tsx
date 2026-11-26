import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronsLeftRightIcon, EllipsisIcon } from "lucide-react";
import { useGT, useMessages } from "gt-react";
import { memo } from "react";

import { laneWaitCounts, reworkOf, waitKindsOf } from "../../lib/boardLaneCards";
import { BOARD_LANE, boardLaneTitle } from "../../lib/boardLanes";
import { type DeliveryCard, type DeliveryLane } from "../../lib/delivery";
import {
  boardMoveIntent,
  FLOW_LABEL,
  groupCards,
  type BoardGrouping,
} from "../../lib/deliveryBoard";
import { cn } from "../../lib/utils";
import { CardDeliveryStatus } from "./CardDeliveryStatus";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { actionLabel } from "./taskActions";
import { InWorkSections, QueueLine, ReworkCount, WaitKinds } from "./BoardLaneCards";
import {
  Age,
  CardActivity,
  CardPeople,
  CardSigns,
  laneTone,
  PriorityPill,
  QaReceiptCounts,
  QaVotes,
  TagList,
  WaitingOn,
} from "./taskParts";

/**
 * What the Waiting on you lane owes in all: its open questions and its sign-offs. A board task's
 * conversation raises nothing in the sidebar or as a notification, so this lane is where a
 * person sees that they are asked.
 */
function LaneWaitCounts(props: { readonly cards: ReadonlyArray<DeliveryCard> }) {
  const { questions, signOffs } = laneWaitCounts(props.cards);
  if (questions === 0 && signOffs === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-3xs font-normal text-warning-foreground">
      {questions > 0 ? (
        <span data-lane-questions={questions}>
          {questions} {questions === 1 ? "question" : "questions"}
        </span>
      ) : null}
      {signOffs > 0 ? (
        <span data-lane-sign-offs={signOffs}>
          {signOffs} {signOffs === 1 ? "sign-off" : "sign-offs"}
        </span>
      ) : null}
    </span>
  );
}

/** The card as any board shows it, local or linked: what it is, where it stands, what it owes. */
export const CardFace = memo(function CardFace(props: {
  readonly card: DeliveryCard;
  readonly now: number;
  readonly onPickTag?: ((tag: string) => void) | undefined;
  readonly menu?: React.ReactNode;
  /** In the queue lane: its place in line, or null when it is not in line. Undefined elsewhere. */
  readonly queuePlace?: number | null | undefined;
}) {
  const { card } = props;
  const waitsOnPerson = card.waitingOn === "person" && card.lane !== "draft";
  const rework = reworkOf(card);
  // The kinds of wait say what is owed; the plain "Waiting on you" stands only when none apply.
  const showsKinds = waitsOnPerson && waitKindsOf(card).length > 0;
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md border bg-card p-2 text-xs shadow-xs",
        waitsOnPerson ? "border-warning/60" : "border-border",
      )}
    >
      <div className="flex items-center gap-1.5">
        <PriorityPill priority={card.priority} by={card.priorityBy} />
        <span className="font-mono text-3xs text-muted-foreground" data-card-number>
          #{card.number}
        </span>
        {card.flow !== "standard" ? (
          <span
            className="rounded bg-muted px-1 text-3xs text-muted-foreground"
            data-card-flow={card.flow}
          >
            {FLOW_LABEL[card.flow] ?? card.flow}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          <Age at={card.updated} now={props.now} label="Last changed" />
          {props.menu}
        </span>
      </div>
      <p className="text-sm leading-snug font-medium break-words">{card.title}</p>
      <TagList tags={card.tags} onPick={props.onPickTag} />
      {props.queuePlace !== undefined ? <QueueLine card={card} place={props.queuePlace} /> : null}
      {rework ? <ReworkCount rounds={rework.rounds} /> : null}
      {showsKinds ? <WaitKinds card={card} /> : null}
      {card.blocker ? (
        <p
          className={cn(
            "line-clamp-2 text-2xs",
            waitsOnPerson ? "text-warning-foreground" : "text-muted-foreground",
          )}
          data-card-blocker
        >
          {card.blocker}
        </p>
      ) : null}
      <CardActivity card={card} />
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          {showsKinds ? null : <WaitingOn card={card} />}
          <QaVotes qa={card.qa} />
          <QaReceiptCounts receipts={card.qaReceipts} />
          <CardSigns card={card} />
        </span>
        <CardPeople card={card} />
      </div>
      <CardDeliveryStatus card={card} variant="card" />
    </div>
  );
});

function DraggableCard(props: {
  readonly card: DeliveryCard;
  /** Whether a card dropped here would be taken; the ring shows only where it would. */
  readonly accepts: boolean;
  readonly now: number;
  readonly busy: boolean;
  readonly onOpen: (card: DeliveryCard) => void;
  readonly onAction: (card: DeliveryCard, action: string) => void;
  readonly onPickTag: (tag: string) => void;
  readonly queuePlace?: number | null | undefined;
}) {
  const { card } = props;
  const drag = useDraggable({ id: `card:${card.id}`, data: { card } });
  const drop = useDroppable({ id: `over:${card.id}`, data: { lane: card.lane, before: card.id } });
  return (
    <div
      ref={(node) => {
        drag.setNodeRef(node);
        drop.setNodeRef(node);
      }}
      {...drag.attributes}
      {...drag.listeners}
      role="button"
      tabIndex={0}
      data-card={card.id}
      data-card-lane={card.lane}
      aria-label={`#${card.number} ${card.title}`}
      onClick={() => props.onOpen(card)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) props.onOpen(card);
      }}
      className={cn(
        "cursor-pointer rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset",
        drag.isDragging && "opacity-30",
        drop.isOver && !drag.isDragging && props.accepts && "ring-2 ring-ring/60",
      )}
    >
      <CardFace
        card={card}
        now={props.now}
        onPickTag={props.onPickTag}
        queuePlace={props.queuePlace}
        menu={
          card.actions.length > 0 ? (
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={`What can be done with #${card.number}`}
                    className="flex size-4 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                {card.actions.map((action) => (
                  <MenuItem
                    key={action}
                    disabled={props.busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onAction(card, action);
                    }}
                  >
                    {actionLabel(action, card)}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : null
        }
      />
    </div>
  );
}

/** Said once at the head of the queue while the engine does not send the slots and who holds them. */
function QueueSlotsNote() {
  const gt = useGT();
  return (
    <p className="px-1 text-3xs text-muted-foreground" data-queue-slots-note>
      {gt("This engine does not report the slots or who holds them yet. The order is its own.")}
    </p>
  );
}

/** Exported for the width test, which renders the real lane at each width. */
export function Lane(props: {
  readonly environmentId: EnvironmentId | null;
  readonly lane: DeliveryLane;
  /** Where each card of the queue stands in line, read over every card the lane holds. */
  readonly places: ReadonlyMap<string, number>;
  readonly total: number;
  readonly grouping: BoardGrouping;
  readonly collapsed: boolean;
  readonly dragged: DeliveryCard | null;
  readonly now: number;
  readonly busy: boolean;
  readonly onToggle: () => void;
  readonly onOpen: (card: DeliveryCard) => void;
  readonly onAction: (card: DeliveryCard, action: string) => void;
  readonly onPickTag: (tag: string) => void;
}) {
  const { lane } = props;
  const m = useMessages();
  const title = boardLaneTitle(lane.lane, m, lane.title);
  const tone = laneTone(lane.lane);
  const { isOver, setNodeRef } = useDroppable({
    id: `lane:${lane.lane}`,
    data: { lane: lane.lane, before: null },
  });
  // The same table as the drop and the task view's column choice: what this lane would do.
  const intent = props.dragged ? boardMoveIntent(props.dragged, lane.lane).intent : null;
  const offer =
    intent && props.dragged && intent.kind !== "refused"
      ? intent.kind === "action"
        ? actionLabel(intent.action, props.dragged)
        : intent.label
      : null;
  const refused = intent?.kind === "refused";
  const groups = groupCards(lane.cards, props.grouping);
  const inQueue = lane.lane === BOARD_LANE.queue;
  const inWork = lane.lane === BOARD_LANE.inWork;
  const card = (item: DeliveryCard) => (
    <DraggableCard
      key={item.id}
      card={item}
      accepts={!props.dragged || offer !== null}
      now={props.now}
      busy={props.busy}
      onOpen={props.onOpen}
      onAction={props.onAction}
      onPickTag={props.onPickTag}
      queuePlace={inQueue ? (props.places.get(item.id) ?? null) : undefined}
    />
  );

  if (props.collapsed) {
    return (
      <section
        ref={setNodeRef}
        data-lane={lane.lane}
        data-lane-collapsed
        className={cn(
          "flex w-9 shrink-0 flex-col items-center overflow-hidden rounded-lg border border-border",
          tone.tint,
          refused && "opacity-40",
          isOver && offer && "ring-2 ring-ring",
        )}
      >
        <span className={cn("h-1 w-full shrink-0", tone.bar)} />
        <button
          type="button"
          onClick={props.onToggle}
          aria-label={`Open ${title}`}
          className="flex flex-1 cursor-pointer flex-col items-center gap-2 py-2 text-xs text-muted-foreground"
        >
          <span className="font-mono" data-lane-count>
            {lane.cards.length}
          </span>
          <span className="[writing-mode:vertical-rl]">{title}</span>
          {props.dragged && offer ? (
            <span className="text-3xs [writing-mode:vertical-rl]">{offer}</span>
          ) : null}
        </button>
      </section>
    );
  }

  return (
    <section
      ref={setNodeRef}
      data-lane={lane.lane}
      className={cn(
        "flex w-68 shrink-0 flex-col overflow-hidden rounded-lg border border-border",
        tone.tint,
        refused && "opacity-40",
        isOver && offer && "ring-2 ring-ring",
      )}
    >
      <span className={cn("h-1 w-full shrink-0", tone.bar)} />
      <h2 className="flex shrink-0 items-center gap-2 px-2.5 py-2 text-xs font-medium">
        <span className="min-w-0 truncate">{title}</span>
        <span
          className="rounded-full bg-background px-1.5 font-mono text-3xs text-muted-foreground"
          data-lane-count
        >
          {lane.cards.length}
          {lane.cards.length !== props.total ? ` of ${props.total}` : ""}
        </span>
        {lane.lane === BOARD_LANE.needsDecision ? <LaneWaitCounts cards={lane.cards} /> : null}
        {props.dragged && offer ? (
          <span className="text-3xs font-normal text-muted-foreground">{offer}</span>
        ) : null}
        <button
          type="button"
          onClick={props.onToggle}
          aria-label={`Fold ${title}`}
          className="ml-auto flex size-4 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <ChevronsLeftRightIcon className="size-3" />
        </button>
      </h2>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-2">
        {inQueue && lane.cards.some((item) => !item.queue) ? <QueueSlotsNote /> : null}
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-1.5">
            {group.title ? (
              <h3 className="px-1 pt-1 text-3xs font-medium tracking-wide text-muted-foreground uppercase">
                {group.title} <span className="font-mono">{group.cards.length}</span>
              </h3>
            ) : null}
            {inWork ? (
              <InWorkSections
                environmentId={props.environmentId}
                cards={group.cards}
                renderCard={card}
              />
            ) : (
              group.cards.map(card)
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
