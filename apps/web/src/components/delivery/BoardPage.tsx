import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronsLeftRightIcon, EllipsisIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { parseBoard, type DeliveryCard, type DeliveryLane } from "../../lib/delivery";
import {
  BOARD_GROUPINGS,
  filterLanes,
  FLOW_LABEL,
  GROUPING_LABEL,
  groupCards,
  hasFilters,
  laneAccepts,
  type BoardGrouping,
} from "../../lib/deliveryBoard";
import { cn } from "../../lib/utils";
import {
  useBoardStore,
  useDeliveryEnabled,
  useDeliveryRead,
  useMinuteClock,
  useStaleReading,
} from "../../state/delivery";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { actionLabel, useTaskActions } from "./taskActions";
import { TaskEditor } from "./TaskEditor";
import {
  Age,
  CardPeople,
  CardSigns,
  laneTone,
  PriorityPill,
  QaVotes,
  TagList,
  WaitingOn,
} from "./taskParts";
import { TaskWorkspace } from "./TaskWorkspace";

const CardFace = memo(function CardFace(props: {
  readonly card: DeliveryCard;
  readonly now: number;
  readonly onPickTag?: ((tag: string) => void) | undefined;
  readonly menu?: React.ReactNode;
}) {
  const { card } = props;
  const waitsOnPerson = card.waitingOn === "person" && card.lane !== "draft";
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md border bg-card p-2 text-xs shadow-xs",
        waitsOnPerson ? "border-amber-500/60" : "border-border",
      )}
    >
      <div className="flex items-center gap-1.5">
        <PriorityPill priority={card.priority} by={card.priorityBy} />
        <span className="font-mono text-[10px] text-muted-foreground" data-card-number>
          #{card.number}
        </span>
        {card.flow !== "standard" ? (
          <span
            className="rounded bg-muted px-1 text-[10px] text-muted-foreground"
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
      <p className="text-[13px] leading-snug font-medium break-words">{card.title}</p>
      <TagList tags={card.tags} onPick={props.onPickTag} />
      {card.blocker ? (
        <p
          className={cn(
            "line-clamp-2 text-[11px]",
            waitsOnPerson ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
          )}
          data-card-blocker
        >
          {card.blocker}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <WaitingOn card={card} />
          <QaVotes qa={card.qa} />
          <CardSigns card={card} />
        </span>
        <CardPeople card={card} />
      </div>
    </div>
  );
});

function DraggableCard(props: {
  readonly card: DeliveryCard;
  readonly now: number;
  readonly busy: boolean;
  readonly onOpen: (card: DeliveryCard) => void;
  readonly onAction: (card: DeliveryCard, action: string) => void;
  readonly onPickTag: (tag: string) => void;
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
        "cursor-pointer rounded-md outline-hidden ring-ring focus-visible:ring-2",
        drag.isDragging && "opacity-30",
        drop.isOver && !drag.isDragging && "ring-2 ring-ring/60",
      )}
    >
      <CardFace
        card={card}
        now={props.now}
        onPickTag={props.onPickTag}
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

function Lane(props: {
  readonly lane: DeliveryLane;
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
  const tone = laneTone(lane.lane);
  const drop = useDroppable({ id: `lane:${lane.lane}`, data: { lane: lane.lane, before: null } });
  const offer = props.dragged ? laneAccepts(props.dragged, lane.lane) : null;
  const refused = props.dragged !== null && offer === null;
  const groups = groupCards(lane.cards, props.grouping);

  if (props.collapsed) {
    return (
      <section
        ref={drop.setNodeRef}
        data-lane={lane.lane}
        data-lane-collapsed
        className={cn(
          "flex w-9 shrink-0 flex-col items-center overflow-hidden rounded-lg border border-border",
          tone.tint,
          refused && "opacity-40",
          drop.isOver && offer && "ring-2 ring-ring",
        )}
      >
        <span className={cn("h-1 w-full shrink-0", tone.bar)} />
        <button
          type="button"
          onClick={props.onToggle}
          aria-label={`Open ${lane.title}`}
          className="flex flex-1 cursor-pointer flex-col items-center gap-2 py-2 text-xs text-muted-foreground"
        >
          <span className="font-mono" data-lane-count>
            {lane.cards.length}
          </span>
          <span className="[writing-mode:vertical-rl]">{lane.title}</span>
          {props.dragged && offer ? (
            <span className="text-[10px] [writing-mode:vertical-rl]">{offer}</span>
          ) : null}
        </button>
      </section>
    );
  }

  return (
    <section
      ref={drop.setNodeRef}
      data-lane={lane.lane}
      className={cn(
        "flex w-68 shrink-0 flex-col overflow-hidden rounded-lg border border-border",
        tone.tint,
        refused && "opacity-40",
        drop.isOver && offer && "ring-2 ring-ring",
      )}
    >
      <span className={cn("h-1 w-full shrink-0", tone.bar)} />
      <h2 className="flex shrink-0 items-center gap-2 px-2.5 py-2 text-xs font-medium">
        <span className="min-w-0 truncate">{lane.title}</span>
        <span
          className="rounded-full bg-background px-1.5 font-mono text-[10px] text-muted-foreground"
          data-lane-count
        >
          {lane.cards.length}
          {lane.cards.length !== props.total ? ` of ${props.total}` : ""}
        </span>
        {props.dragged && offer ? (
          <span className="text-[10px] font-normal text-muted-foreground">{offer}</span>
        ) : null}
        <button
          type="button"
          onClick={props.onToggle}
          aria-label={`Fold ${lane.title}`}
          className="ml-auto flex size-4 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <ChevronsLeftRightIcon className="size-3" />
        </button>
      </h2>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-2">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-1.5">
            {group.title ? (
              <h3 className="px-1 pt-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {group.title} <span className="font-mono">{group.cards.length}</span>
              </h3>
            ) : null}
            {group.cards.map((card) => (
              <DraggableCard
                key={card.id}
                card={card}
                now={props.now}
                busy={props.busy}
                onOpen={props.onOpen}
                onAction={props.onAction}
                onPickTag={props.onPickTag}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function BoardColumns(props: {
  readonly lanes: ReadonlyArray<DeliveryLane>;
  readonly all: ReadonlyArray<DeliveryLane>;
  readonly busy: boolean;
  readonly onOpen: (card: DeliveryCard) => void;
  readonly onAction: (card: DeliveryCard, action: string) => void;
  readonly onMove: (card: DeliveryCard, lane: string, before: string | null) => void;
}) {
  const now = useMinuteClock();
  const grouping = useBoardStore((state) => state.grouping);
  const folds = useBoardStore((state) => state.laneFolds);
  const foldLane = useBoardStore((state) => state.foldLane);
  const setFilters = useBoardStore((state) => state.setFilters);
  const [dragged, setDragged] = useState<DeliveryCard | null>(null);
  // A press that does not move is a click, which opens the card.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // An empty lane stands folded, so that the lanes with cards fit on the screen. It still
  // takes a card that is dropped on it, and a person may open it or fold any other.
  const isFolded = (lane: DeliveryLane) => folds[lane.lane] ?? lane.cards.length === 0;

  const onDragStart = (event: DragStartEvent) =>
    setDragged((event.active.data.current?.card as DeliveryCard | undefined) ?? null);
  const onDragEnd = (event: DragEndEvent) => {
    const card = dragged;
    setDragged(null);
    const target = event.over?.data.current as
      | { lane?: string; before?: string | null }
      | undefined;
    if (!card || !target?.lane) return;
    if (target.before === card.id) return;
    // Dropped on its own lane and not on a card, it stays where it is.
    if (target.lane === card.lane && !target.before) return;
    props.onMove(card, target.lane, target.before ?? null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragged(null)}
    >
      <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3" data-delivery-board>
        {props.lanes.map((lane) => (
          <Lane
            key={lane.lane}
            lane={lane}
            total={props.all.find((item) => item.lane === lane.lane)?.cards.length ?? 0}
            grouping={grouping}
            collapsed={isFolded(lane)}
            dragged={dragged}
            now={now}
            busy={props.busy}
            onToggle={() => foldLane(lane.lane, !isFolded(lane))}
            onOpen={props.onOpen}
            onAction={props.onAction}
            onPickTag={(tag) => setFilters({ tag })}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {dragged ? (
          <div className="w-64 rotate-1 cursor-grabbing">
            <CardFace card={dragged} now={now} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * The delivery board. A lane is where the engine put a card. A card that is
 * dragged asks the engine to submit, pause, resume or triage it again; a
 * lane a card reaches by passing a stage cannot be reached by dragging.
 */
export function BoardPage() {
  const environmentId = usePrimaryEnvironmentId();
  const enabled = useDeliveryEnabled(environmentId);
  const active = enabled ? environmentId : null;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { task?: string; new?: boolean };
  const view = useBoardStore((state) => state.view);
  const setView = useBoardStore((state) => state.setView);
  const filters = useBoardStore((state) => state.filters);
  const setFilters = useBoardStore((state) => state.setFilters);
  const clearFilters = useBoardStore((state) => state.clearFilters);
  const grouping = useBoardStore((state) => state.grouping);
  const setGrouping = useBoardStore((state) => state.setGrouping);

  const showingBoard = !search.task && !search.new;
  const board = useDeliveryRead(active, `/api/lanes?view=${view}`, {
    pollMs: showingBoard ? 4_000 : 15_000,
  });
  const parsed = useMemo(() => parseBoard(board.body), [board.body]);
  const lanes = useMemo(() => filterLanes(parsed?.lanes ?? [], filters), [filters, parsed]);
  const stale = useStaleReading(board.readAt);
  const open = (task: string | null) =>
    void navigate({ to: "/board", search: task ? { task } : {} });
  const actions = useTaskActions(active, { onDone: board.refresh });
  const shown = lanes.reduce((sum, lane) => sum + lane.cards.length, 0);

  if (search.new) {
    return (
      <TaskEditor
        environmentId={active}
        taskId={null}
        onClose={() => open(null)}
        onSaved={(task) => open(task)}
        from="Board"
      />
    );
  }
  if (search.task) {
    return (
      <TaskWorkspace
        environmentId={active}
        taskId={search.task}
        from="Board"
        onClose={() => open(null)}
        onOpenTask={open}
      />
    );
  }

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 py-2">
            <h1 className="text-sm font-medium">Board</h1>
            <Select value={view} onValueChange={(value) => setView(String(value))}>
              <SelectTrigger
                aria-label="Board view"
                size="compact"
                variant="ghost"
                className="w-auto min-w-0"
              >
                <SelectValue>
                  {parsed?.views.find((item) => item.id === view)?.title ?? view}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {(parsed?.views ?? [{ id: "development", title: "Development" }]).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <span className="relative flex items-center">
              <SearchIcon className="pointer-events-none absolute left-2 z-10 size-3.5 text-muted-foreground" />
              <Input
                aria-label="Search tasks"
                placeholder="Search by #number, title, tag, owner"
                className="h-7 w-64 pl-7 text-xs"
                value={filters.q}
                onChange={(event) => setFilters({ q: event.target.value })}
              />
            </span>
            <Select
              value={grouping}
              onValueChange={(value) => setGrouping(String(value) as BoardGrouping)}
            >
              <SelectTrigger
                aria-label="Group cards by"
                size="compact"
                variant="ghost"
                className="w-auto min-w-0"
              >
                <SelectValue>
                  {grouping === "none" ? "Group" : `By ${GROUPING_LABEL[grouping].toLowerCase()}`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {BOARD_GROUPINGS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {GROUPING_LABEL[item]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {hasFilters(filters) ? (
              <Button size="xs" variant="ghost" onClick={clearFilters} data-board-clear-filters>
                <XIcon />
                {shown} shown, clear
              </Button>
            ) : null}
            {parsed && parsed.waiting > 0 ? (
              <Button
                size="xs"
                variant={filters.waiting ? "secondary" : "ghost"}
                className="text-amber-700 dark:text-amber-300"
                onClick={() => setFilters({ waiting: !filters.waiting })}
                data-board-waiting
              >
                {parsed.waiting} waiting on you
              </Button>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              <span className="font-mono text-[10px] text-muted-foreground">
                {board.readAt ? (stale ? "stale" : "live") : enabled ? "not read yet" : ""}
              </span>
              <Button
                size="xs"
                disabled={!enabled}
                onClick={() => void navigate({ to: "/board", search: { new: true } })}
                data-board-new-task
              >
                <PlusIcon />
                New task
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh board"
                onClick={board.refresh}
              >
                <RefreshIcon className="size-3.5" refreshing={board.isPending} />
              </Button>
            </div>
          </div>
        </WorkspacePageHeader>

        {!enabled ? (
          <p className="p-6 text-sm text-muted-foreground">
            Delivery is turned off for this environment. Turn it on in the server settings to see
            the board.
          </p>
        ) : board.error ? (
          <p className="p-6 text-sm text-warning">
            Delivery engine not reachable. {board.error} Nothing shown here is current.
          </p>
        ) : (
          <>
            {actions.problem ? (
              <p
                className="flex items-start gap-2 px-4 pt-2 text-sm text-warning"
                data-delivery-problem
              >
                <span className="min-w-0 flex-1">{actions.problem}</span>
                <button
                  type="button"
                  aria-label="Dismiss"
                  className="cursor-pointer"
                  onClick={actions.clearProblem}
                >
                  <XIcon className="size-3.5" />
                </button>
              </p>
            ) : null}
            {parsed?.note ? (
              <p className="px-4 pt-2 text-xs text-muted-foreground">{parsed.note}</p>
            ) : null}
            {parsed?.notices.map((notice) => (
              <p key={notice.key} className="px-4 pt-2 text-xs text-warning">
                {notice.text} Seen {notice.count} time{notice.count === 1 ? "" : "s"}.
              </p>
            ))}
            <BoardColumns
              lanes={lanes}
              all={parsed?.lanes ?? []}
              busy={actions.busy}
              onOpen={(card) => open(card.id)}
              onAction={actions.run}
              onMove={(card, lane, before) => void actions.move(card, lane, before)}
            />
          </>
        )}
      </div>
      {actions.dialog}
    </SidebarInset>
  );
}
