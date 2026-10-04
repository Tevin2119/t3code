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
import { memo, useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { parseBoard, type DeliveryCard, type DeliveryLane } from "../../lib/delivery";
import {
  boardSetOf,
  BOARD_GROUPINGS,
  filterLanes,
  FLOW_LABEL,
  GROUPING_LABEL,
  groupCards,
  hasFilters,
  moveIntent,
  type BoardGrouping,
} from "../../lib/deliveryBoard";
import { cn } from "../../lib/utils";
import {
  useBoardStore,
  useDeliveryAct,
  useDeliveryEnabled,
  useDeliveryEnvironmentId,
  usePersonName,
  useDeliveryRead,
  useMinuteClock,
  useStaleReading,
} from "../../state/delivery";
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
import { ActiveFilterChips, LaneFilterMenu } from "./BoardFilterControls";
import { BoardDialog, BoardPicker, type PickerItem } from "./BoardPicker";
import { BoardSeatsDialog } from "./BoardSeatsDialog";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { HowItFits } from "./HowItFits";
import { SharedBoard } from "./SharedBoard";

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
  /** Whether a card dropped here would be taken; the ring shows only where it would. */
  readonly accepts: boolean;
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
        drop.isOver && !drag.isDragging && props.accepts && "ring-2 ring-ring/60",
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
  // The same table as the drop and the task view's column choice: what this lane would do.
  const intent = props.dragged ? moveIntent(props.dragged, lane.lane) : null;
  const offer =
    intent && props.dragged && intent.kind !== "refused"
      ? intent.kind === "action"
        ? actionLabel(intent.action, props.dragged)
        : intent.label
      : null;
  const refused = intent?.kind === "refused";
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
                accepts={!props.dragged || offer !== null}
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
  const search = useSearch({ strict: false }) as { task?: string; new?: boolean; from?: string };
  // The engine of the environment the work lives in: a conversation's own, when a task is made from one.
  const environmentId = useDeliveryEnvironmentId(search.new ? (search.from ?? null) : null);
  const enabled = useDeliveryEnabled(environmentId);
  const active = enabled ? environmentId : null;
  const setDeliveryEnvironment = useBoardStore((state) => state.setDeliveryEnvironment);
  const navigate = useNavigate();
  const view = useBoardStore((state) => state.view);
  const setView = useBoardStore((state) => state.setView);
  const filters = useBoardStore((state) => state.filters);
  const setFilters = useBoardStore((state) => state.setFilters);
  const clearFilters = useBoardStore((state) => state.clearFilters);
  const grouping = useBoardStore((state) => state.grouping);
  const setGrouping = useBoardStore((state) => state.setGrouping);

  const showingBoard = !search.task && !search.new;
  const boardSet = useBoardStore((state) => boardSetOf(state.boardSet));
  const setBoardSet = useBoardStore((state) => state.setBoardSet);
  const person = usePersonName();
  const boardAct = useDeliveryAct(active, "board setup");
  // A board or view being made or edited, and what the engine said when it refused.
  const [dialog, setDialog] = useState<{
    readonly kind: "board" | "view";
    readonly editing: PickerItem | null;
  } | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [seatsFor, setSeatsFor] = useState<{ readonly id: string; readonly title: string } | null>(
    null,
  );
  const [dialogProblem, setDialogProblem] = useState<string | null>(null);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [shared, setShared] = useState(false);
  const board = useDeliveryRead(active, `/api/lanes?view=${view}&set=${boardSet}`, {
    pollMs: shared && showingBoard ? 0 : showingBoard ? 4_000 : 15_000,
  });
  const parsed = useMemo(() => parseBoard(board.body), [board.body]);
  // The boards last read stay listed while another board is being read, one just made with them.
  type KnownBoard = NonNullable<typeof parsed>["sets"][number];
  const [knownBoards, setKnownBoards] = useState<ReadonlyArray<KnownBoard>>([]);
  const [readSets, setReadSets] = useState<ReadonlyArray<KnownBoard> | null>(null);
  if (parsed && parsed.sets !== readSets) {
    setReadSets(parsed.sets);
    setKnownBoards(parsed.sets);
  }
  const lanes = useMemo(() => filterLanes(parsed?.lanes ?? [], filters), [filters, parsed]);
  // The columns as the engine names them, with what each holds before any filter.
  const laneChoices = useMemo(
    () =>
      (parsed?.lanes ?? []).map((lane) => ({
        lane: lane.lane,
        title: lane.title,
        count: lane.cards.length,
      })),
    [parsed],
  );
  const laneTitle = (lane: string) => laneChoices.find((item) => item.lane === lane)?.title ?? lane;
  const stale = useStaleReading(board.readAt);
  const open = (task: string | null) =>
    void navigate({ to: "/board", search: task ? { task } : {} });
  const actions = useTaskActions(active, { onDone: board.refresh });
  const chosenBoard = parsed?.sets.find((item) => item.id === boardSet) ?? null;
  // A board or view that was removed, here or elsewhere, gives way to what is always there.
  // The engine refuses a board or view it no longer has, so its refusal also sends the Board back.
  const gone = board.error ?? "";
  useEffect(() => {
    if (/no board "/.test(gone) && boardSet !== "unsorted") setBoardSet("unsorted");
    if (/no view "/.test(gone) && view !== "development") setView("development");
    if (!parsed) return;
    // Only a read made for the current choice says whether it is there: an earlier read does
    // not list a board or view made since, and one that is gone is refused by the engine.
    if (parsed.set === boardSet && !parsed.sets.some((item) => item.id === boardSet)) {
      setBoardSet("unsorted");
    }
    if (parsed.view === view && !parsed.views.some((item) => item.id === view)) {
      setView("development");
    }
  }, [boardSet, gone, parsed, setBoardSet, setView, view]);
  const saveDialog = async (input: {
    readonly title: string;
    readonly description: string;
    readonly lanes?: ReadonlyArray<string>;
    readonly repository?: string;
    readonly base?: string;
  }) => {
    if (!dialog) return;
    setDialogBusy(true);
    setDialogProblem(null);
    const base = dialog.kind === "board" ? "/api/boards" : "/api/views";
    const result = await boardAct(dialog.editing ? `${base}/${dialog.editing.id}/edit` : base, {
      ...input,
      by: person,
    });
    setDialogBusy(false);
    if (!result.ok) {
      setDialogProblem(result.why);
      return;
    }
    const made = result.body as { readonly id?: string } | null;
    if (!dialog.editing && made?.id && dialog.kind === "board") {
      const id = made.id;
      setKnownBoards((boards) => [
        {
          id,
          title: input.title,
          description: input.description,
          kind: "own",
          count: 0,
          target: null,
        },
        ...boards.filter((item) => item.id !== id),
      ]);
    }
    if (!dialog.editing && made?.id) (dialog.kind === "board" ? setBoardSet : setView)(made.id);
    setDialog(null);
    board.refresh();
  };
  const removeDialog = async () => {
    if (!dialog?.editing) return;
    setDialogBusy(true);
    const base = dialog.kind === "board" ? "/api/boards" : "/api/views";
    const result = await boardAct(`${base}/${dialog.editing.id}/remove`, { by: person });
    setDialogBusy(false);
    if (!result.ok) {
      setDialogProblem(result.why);
      return;
    }
    // What was shown is gone: the Board shows what is always there.
    if (dialog.kind === "board") {
      const gone = dialog.editing.id;
      setKnownBoards((boards) => boards.filter((item) => item.id !== gone));
      if (gone === boardSet) setBoardSet("unsorted");
    }
    if (dialog.kind === "view" && dialog.editing.id === view) setView("development");
    setDialog(null);
    board.refresh();
  };
  const shown = lanes.reduce((sum, lane) => sum + lane.cards.length, 0);

  if (search.new) {
    return (
      <TaskEditor
        environmentId={active}
        taskId={null}
        onClose={() => open(null)}
        onSaved={(task) => {
          // The task was filed in that environment: the board goes on showing it there.
          if (environmentId) setDeliveryEnvironment(environmentId);
          open(task);
        }}
        from="Board"
        fromConversation={search.from ?? null}
        board={
          chosenBoard?.kind === "own" ? { id: chosenBoard.id, title: chosenBoard.title } : null
        }
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
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={shared}
              onClick={() => setShared(!shared)}
            >
              Shared boards
            </Button>
            <EnvironmentPicker value={environmentId} onChoose={setDeliveryEnvironment} />
            {!shared ? (
              <>
                <BoardPicker
                  label="Board"
                  marker="board"
                  items={
                    parsed?.sets ??
                    (knownBoards.length > 0
                      ? knownBoards
                      : [{ id: boardSet, title: boardSet, description: "", kind: "built-in" }])
                  }
                  value={boardSet}
                  everything={{ id: "all", label: "Show every task" }}
                  newLabel="New board…"
                  noneYet="You have no boards yet. New board… makes one to group tasks, such as Pilot work; tasks are put on it from New task or a task's page."
                  onChoose={setBoardSet}
                  onCreate={() => setDialog({ kind: "board", editing: null })}
                  onEdit={(item) => setDialog({ kind: "board", editing: item })}
                />
                <BoardPicker
                  label="Board view"
                  marker="view"
                  items={
                    parsed?.views ?? [{ id: view, title: view, description: "", kind: "built-in" }]
                  }
                  value={view}
                  everything={{ id: "development", label: "Show every column" }}
                  newLabel="New view…"
                  onChoose={setView}
                  onCreate={() => setDialog({ kind: "view", editing: null })}
                  onEdit={(item) => setDialog({ kind: "view", editing: item })}
                />
                <span className="relative hidden items-center md:flex">
                  <SearchIcon className="pointer-events-none absolute left-2 z-10 size-3.5 text-muted-foreground" />
                  <Input
                    aria-label="Search tasks"
                    placeholder="Search by #number, title, tag, owner"
                    className="h-7 w-64 pl-7 text-xs"
                    value={filters.q}
                    onChange={(event) => setFilters({ q: event.target.value })}
                  />
                </span>
                <Button
                  size="icon-xs"
                  variant={filters.q ? "secondary" : "ghost"}
                  aria-label={mobileSearchOpen ? "Close board search" : "Search the board"}
                  aria-expanded={mobileSearchOpen}
                  className="md:hidden"
                  onClick={() => setMobileSearchOpen((open) => !open)}
                  data-board-search-toggle
                >
                  {mobileSearchOpen ? <XIcon /> : <SearchIcon />}
                </Button>
                {mobileSearchOpen ? (
                  <span className="relative flex min-w-0 basis-full items-center md:hidden">
                    <SearchIcon className="pointer-events-none absolute left-2 z-10 size-3.5 text-muted-foreground" />
                    <Input
                      aria-label="Search tasks"
                      placeholder="Search by #number, title, tag, owner"
                      className="h-7 w-full pl-7 text-xs"
                      value={filters.q}
                      onChange={(event) => setFilters({ q: event.target.value })}
                      autoFocus
                    />
                  </span>
                ) : null}
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
                      {grouping === "none"
                        ? "Group"
                        : `By ${GROUPING_LABEL[grouping].toLowerCase()}`}
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
                <LaneFilterMenu
                  lanes={laneChoices}
                  chosen={filters.lanes}
                  onChange={(chosen) => setFilters({ lanes: chosen })}
                />
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
              </>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              {!shared ? (
                <span className="font-mono text-[10px] text-muted-foreground">
                  {board.readAt ? (stale ? "stale" : "live") : enabled ? "not read yet" : ""}
                </span>
              ) : null}
              <Button
                size="xs"
                disabled={!enabled}
                onClick={() => void navigate({ to: "/board", search: { new: true } })}
                data-board-new-task
              >
                <PlusIcon />
                New task
              </Button>
              <HowItFits />
              {!shared ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Refresh board"
                  onClick={board.refresh}
                >
                  <RefreshIcon className="size-3.5" refreshing={board.isPending} />
                </Button>
              ) : null}
            </div>
          </div>
        </WorkspacePageHeader>
        {!shared && hasFilters(filters) ? (
          <ActiveFilterChips
            className="px-4 pt-2"
            filters={filters}
            laneTitle={laneTitle}
            shown={shown}
            onClear={(patch) => setFilters(patch)}
            onReset={clearFilters}
          />
        ) : null}

        {!enabled ? (
          <p className="p-6 text-sm text-muted-foreground">
            Delivery is turned off for this environment. Turn it on in the server settings to see
            the board.
          </p>
        ) : shared ? (
          <SharedBoard environmentId={active} onOpen={open} />
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
            {chosenBoard && chosenBoard.id !== "unsorted" && chosenBoard.description ? (
              <p className="px-4 pt-2 text-xs text-muted-foreground" data-board-set-note>
                {chosenBoard.title}: {chosenBoard.description}
              </p>
            ) : null}
            {parsed !== null && parsed.lanes.every((lane) => lane.cards.length === 0) ? (
              <p className="px-4 pt-2 text-xs text-muted-foreground" data-board-empty-pilot>
                {chosenBoard?.kind === "own"
                  ? `Nothing on ${chosenBoard.title} yet. A task made while it is chosen goes on it.`
                  : "Nothing here yet. New task starts some; a board of your own keeps a section of work apart."}
                {(parsed.sets.find((entry) => entry.id === "qualification")?.count ?? 0) > 0
                  ? ` The qualification's ${parsed.sets.find((entry) => entry.id === "qualification")?.count} tasks are kept, as its evidence, under Qualification.`
                  : ""}
              </p>
            ) : null}
            {dialog ? (
              <BoardDialog
                kind={dialog.kind}
                editing={dialog.editing}
                environmentId={active}
                by={person}
                columns={(parsed?.lanes ?? []).map((lane) => ({
                  lane: lane.lane,
                  title: lane.title,
                }))}
                chosenColumns={
                  dialog.editing
                    ? (parsed?.views.find((item) => item.id === dialog.editing?.id)?.lanes ?? [])
                    : []
                }
                busy={dialogBusy}
                problem={dialogProblem}
                onClose={() => {
                  setDialog(null);
                  setDialogProblem(null);
                }}
                onSave={(input) => void saveDialog(input)}
                onRemove={() => void removeDialog()}
                onSeats={() => {
                  const editing = dialog.editing;
                  if (!editing) return;
                  setDialog(null);
                  setDialogProblem(null);
                  setSeatsFor({ id: editing.id, title: editing.title });
                }}
              />
            ) : null}
            {seatsFor ? (
              <BoardSeatsDialog
                environmentId={active}
                board={seatsFor}
                onClose={() => setSeatsFor(null)}
              />
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
              onMove={(card, lane, before) => actions.moveTo(card, lane, before)}
            />
          </>
        )}
      </div>
      {actions.dialog}
    </SidebarInset>
  );
}
