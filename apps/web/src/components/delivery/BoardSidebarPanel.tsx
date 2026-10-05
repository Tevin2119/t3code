import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronRightIcon, PlusIcon, SearchIcon, UsersIcon, XIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  parseBoard,
  parseCards,
  TASK_PRIORITIES,
  type DeliveryCard,
  type TaskPriority,
  crewLine,
  seatsAtWork,
} from "../../lib/delivery";
import {
  activeFilters,
  hasFilters,
  LANE_TITLE,
  matchesCard,
  PRIORITY_LABEL,
  queryValue,
  boardSetOf,
  type DeliveryBoardSearch,
} from "../../lib/deliveryBoard";
import { cn } from "../../lib/utils";
import {
  useBoardStore,
  useBoardPreferences,
  useBoardControls,
  useDeliveryEnabled,
  useDeliveryRead,
  useMinuteClock,
} from "../../state/delivery";
import { useDeliveryEnvironmentId } from "../../state/delivery";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { APP_BUILD } from "../../branding";
import { ActiveFilterChips, LaneFilterMenu } from "./BoardFilterControls";
import { Age, CardSigns, laneTone, PriorityPill } from "./taskParts";
import { BoardIcon } from "./BoardIcon";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { EngineDownNotice, EnginePanel } from "./EnginePanel";

const ANY = "__any__";

function Row(props: {
  readonly card: DeliveryCard;
  readonly now: number;
  readonly selected: boolean;
  readonly onOpen: (card: DeliveryCard) => void;
}) {
  const { card } = props;
  return (
    <li>
      <button
        type="button"
        data-board-panel-task={card.id}
        aria-current={props.selected ? "page" : undefined}
        onClick={() => props.onOpen(card)}
        className={cn(
          "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-sidebar-row-hover",
          props.selected && "bg-sidebar-accent",
        )}
      >
        <span className="flex items-center gap-1.5">
          <span className={cn("size-2 shrink-0 rounded-full", laneTone(card.lane).bar)} />
          <span className="font-mono text-[10px] text-sidebar-muted-foreground">
            #{card.number}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{card.title}</span>
          <Age at={card.updated} now={props.now} label="Last changed" />
        </span>
        <span className="flex items-center gap-2 pl-3.5">
          <PriorityPill priority={card.priority} />
          <CardSigns card={card} />
          {card.workers.length > 0 ? (
            <span className="truncate text-[10px] text-sidebar-muted-foreground">
              {crewLine(card)}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/**
 * A group of the sidebar that folds by its header, as the groups of threads do. The choice is
 * kept on this device. The header is a full row, so that it is easy to reach on a phone.
 */
function Group(props: {
  readonly environmentId: EnvironmentId | null;
  readonly name: string;
  readonly title: string;
  readonly count?: number;
  readonly hint?: string | null;
  readonly defaultFolded?: boolean;
  readonly children: ReactNode;
}) {
  const stored = useBoardPreferences(props.environmentId).panelFolds[props.name];
  const { foldPanel } = useBoardControls(props.environmentId);
  const folded = stored ?? props.defaultFolded ?? false;
  return (
    <section data-board-panel-section={props.name} data-folded={folded ? "true" : "false"}>
      <button
        type="button"
        className="flex min-h-8 w-full cursor-pointer items-center gap-1 rounded-md px-1 text-left text-[10px] font-medium tracking-wide text-sidebar-muted-foreground uppercase hover:bg-sidebar-row-hover"
        aria-expanded={!folded}
        onClick={() => foldPanel(props.name, !folded)}
        data-board-panel-fold={props.name}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-150",
            !folded && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate">{props.title}</span>
        {props.count !== undefined ? <span className="font-mono">{props.count}</span> : null}
      </button>
      {folded && props.hint ? (
        <p className="px-6 pb-1 text-[10px] text-sidebar-muted-foreground normal-case">
          {props.hint}
        </p>
      ) : null}
      {folded ? null : props.children}
    </section>
  );
}

function Section(props: {
  readonly environmentId: EnvironmentId | null;
  readonly title: string;
  readonly cards: ReadonlyArray<DeliveryCard>;
  readonly empty?: string;
  readonly now: number;
  readonly selected: string | null;
  readonly onOpen: (card: DeliveryCard) => void;
  readonly name: string;
  readonly defaultFolded?: boolean;
}) {
  if (props.cards.length === 0 && !props.empty) return null;
  return (
    <Group
      environmentId={props.environmentId}
      name={props.name}
      title={props.title}
      count={props.cards.length}
      {...(props.defaultFolded ? { defaultFolded: true } : {})}
    >
      {props.cards.length === 0 ? (
        <p className="px-2 pb-1 text-xs text-sidebar-muted-foreground">{props.empty}</p>
      ) : (
        <ul className="flex flex-col">
          {props.cards.map((card) => (
            <Row
              key={card.id}
              card={card}
              now={props.now}
              selected={props.selected === card.id}
              onOpen={props.onOpen}
            />
          ))}
        </ul>
      )}
    </Group>
  );
}

/**
 * The sidebar while the Board is open: tasks in place of
 * threads. A task is started, found and opened from here, and what waits for
 * a person is at the top.
 */
export function BoardSidebarPanel() {
  const search = useSearch({ strict: false }) as DeliveryBoardSearch;
  const pathname = useLocation({ select: (location) => location.pathname });
  const onBoard = pathname === "/board";
  const environmentId = useDeliveryEnvironmentId(
    onBoard && search.new ? (search.from ?? null) : null,
    onBoard ? (search.environment ?? null) : null,
  );
  return (
    <EnvironmentBoardSidebar key={environmentId ?? "unavailable"} environmentId={environmentId} />
  );
}

function EnvironmentBoardSidebar({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const { isReady } = useEnvironments();
  const enabled = useDeliveryEnabled(environmentId);
  const setDeliveryEnvironment = useBoardStore((state) => state.setDeliveryEnvironment);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const location = useLocation({
    select: (at) => ({
      pathname: at.pathname,
      search: at.search as { task?: string; thread?: string },
    }),
  });
  const selected = location.search.task ?? location.search.thread ?? null;
  const preferences = useBoardPreferences(environmentId);
  const { filters, view, shared } = preferences;
  const { setFilters, clearFilters, setShared } = useBoardControls(environmentId);
  const boardSet = boardSetOf(preferences.boardSet);
  const now = useMinuteClock();

  const q = filters.q.trim();
  // The engine looks in what is asked too, which a card does not carry.
  const read = useDeliveryRead(
    enabled && !shared ? environmentId : null,
    q
      ? `/api/tasks?q=${queryValue(q)}&limit=100&set=${boardSet}`
      : `/api/tasks?limit=200&set=${boardSet}`,
    { pollMs: 6_000 },
  );
  // The columns of the board, as the engine names them, for the filter by column.
  const lanesRead = useDeliveryRead(
    enabled && !shared ? environmentId : null,
    `/api/lanes?view=${view}&set=${boardSet}`,
    {
      pollMs: 15_000,
    },
  );
  const board = useMemo(() => parseBoard(lanesRead.body), [lanesRead.body]);
  const laneChoices = useMemo(
    () =>
      (board?.lanes ?? []).map((lane) => ({
        lane: lane.lane,
        title: lane.title,
        count: lane.cards.length,
      })),
    [board],
  );
  const laneTitle = (lane: string) =>
    laneChoices.find((item) => item.lane === lane)?.title ?? LANE_TITLE[lane] ?? lane;
  const cards = useMemo(() => parseCards(read.body), [read.body]);
  const kept = useMemo(
    () => cards.filter((card) => matchesCard(card, { ...filters, q: "" })),
    [cards, filters],
  );
  const teams = useMemo(() => [...new Set(cards.map((card) => card.team))].sort(), [cards]);
  const tags = useMemo(
    () => [...new Set(cards.flatMap((card) => card.tags))].sort().slice(0, 40),
    [cards],
  );

  const close = () => {
    if (isMobile) setOpenMobile(false);
  };
  const open = (card: DeliveryCard) => {
    close();
    void navigate({
      to: "/board",
      search: { task: card.id, ...(environmentId ? { environment: environmentId } : {}) },
    });
  };
  const chooseEnvironment = (environment: string) => {
    setDeliveryEnvironment(environment);
    void navigate({ to: "/board", search: { environment } });
  };
  // Until the tasks are read, an empty list says nothing about the board.
  const unread =
    read.readAt === null
      ? read.error
        ? "The engine did not answer."
        : "Reading the board..."
      : null;
  const searching = hasFilters(filters);
  const filterCount = activeFilters(filters, laneTitle).filter((item) => item.key !== "q").length;
  const live = kept.filter((card) => !["completed", "draft", "chat"].includes(card.lane));
  const chats = kept.filter((card) => card.lane === "chat");
  const waiting = live.filter((card) => card.waitingOn === "person");
  // Being worked on: a seat is at work. A card whose seats are all held waits with the rest.
  const working = live.filter(
    (card) => card.waitingOn !== "person" && seatsAtWork(card).length > 0,
  );
  const rest = live.filter((card) => card.waitingOn !== "person" && seatsAtWork(card).length === 0);

  if (shared)
    return (
      <SidebarContent className="overflow-x-hidden" data-board-panel>
        <SidebarGroup className="gap-2 p-[var(--sidebar-content-inset)]">
          <EnvironmentPicker value={environmentId} onChoose={chooseEnvironment} />
          <p className="px-1 text-xs text-sidebar-muted-foreground">
            Shared boards show tasks across machines. Choose Local boards for this environment's
            task list.
          </p>
          <Button size="sm" variant="outline" onClick={() => setShared(false)}>
            Local boards
          </Button>
        </SidebarGroup>
      </SidebarContent>
    );

  return (
    <SidebarContent className="overflow-x-hidden" data-board-panel>
      <SidebarGroup className="gap-2 p-[var(--sidebar-content-inset)]">
        <EnvironmentPicker value={environmentId} onChoose={chooseEnvironment} />
        {environmentId ? <EnginePanel environmentId={environmentId} /> : null}
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            className="flex-1 justify-start"
            disabled={!enabled}
            onClick={() => {
              close();
              void navigate({
                to: "/board",
                search: { new: true, ...(environmentId ? { environment: environmentId } : {}) },
              });
            }}
            data-board-panel-new
          >
            <PlusIcon />
            New task
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Profiles"
            onClick={() => {
              close();
              if (environmentId) setDeliveryEnvironment(environmentId);
              void navigate({ to: "/profiles" });
            }}
            data-board-panel-profiles
          >
            <UsersIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Show the board"
            onClick={() => {
              close();
              void navigate({
                to: "/board",
                search: { ...(environmentId ? { environment: environmentId } : {}) },
              });
            }}
          >
            <BoardIcon />
          </Button>
          <Button
            size="icon-sm"
            variant={filters.q ? "secondary" : "ghost"}
            aria-label={mobileSearchOpen ? "Close task search" : "Search tasks"}
            aria-expanded={mobileSearchOpen}
            className="md:hidden"
            onClick={() => setMobileSearchOpen((open) => !open)}
          >
            {mobileSearchOpen ? <XIcon /> : <SearchIcon />}
          </Button>
        </div>

        <span className="relative hidden items-center md:flex">
          <SearchIcon className="pointer-events-none absolute left-2 z-10 size-3.5 text-sidebar-muted-foreground" />
          <Input
            type="search"
            aria-label="Search tasks"
            placeholder="#1001, a title, a tag"
            className="h-8 pl-7 text-xs"
            value={filters.q}
            onChange={(event) => setFilters({ q: event.target.value })}
            data-board-panel-search
          />
        </span>
        {mobileSearchOpen ? (
          <span className="relative flex items-center md:hidden">
            <SearchIcon className="pointer-events-none absolute left-2 z-10 size-3.5 text-sidebar-muted-foreground" />
            <Input
              type="search"
              aria-label="Search tasks"
              placeholder="#1001, a title, a tag"
              className="h-8 pl-7 text-xs"
              value={filters.q}
              onChange={(event) => setFilters({ q: event.target.value })}
              data-board-panel-search
              autoFocus
            />
          </span>
        ) : null}

        {boardSet !== "unsorted" ? (
          <p
            className="px-1 text-[10px] text-sidebar-muted-foreground"
            data-board-panel-set={boardSet}
          >
            Showing: {board?.sets.find((item) => item.id === boardSet)?.title ?? boardSet}. Change
            it at the top of the Board.
          </p>
        ) : null}
        <Group
          environmentId={environmentId}
          name="filters"
          title="Filters"
          count={filterCount}
          hint={filterCount > 0 ? "Some are on: see below." : null}
        >
          <div className="flex flex-wrap items-center gap-1 pb-1 pl-1">
            <Button
              size="xs"
              variant={filters.waiting ? "secondary" : "ghost"}
              aria-pressed={filters.waiting}
              onClick={() => setFilters({ waiting: !filters.waiting })}
            >
              Waiting on you
            </Button>
            <LaneFilterMenu
              lanes={laneChoices}
              chosen={filters.lanes}
              onChange={(chosen) => setFilters({ lanes: chosen })}
            />
            <Select
              value={filters.priority ?? ANY}
              onValueChange={(value) =>
                setFilters({ priority: value === ANY ? null : (value as TaskPriority) })
              }
            >
              <SelectTrigger
                aria-label="Priority"
                size="compact"
                variant="ghost"
                className="w-auto min-w-0"
              >
                <SelectValue>
                  {filters.priority ? PRIORITY_LABEL[filters.priority] : "Priority"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value={ANY}>Any priority</SelectItem>
                {TASK_PRIORITIES.map((priority) => (
                  <SelectItem key={priority} value={priority}>
                    {PRIORITY_LABEL[priority]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {teams.length > 1 ? (
              <Select
                value={filters.team ?? ANY}
                onValueChange={(value) =>
                  setFilters({ team: value === ANY ? null : String(value) })
                }
              >
                <SelectTrigger
                  aria-label="Team"
                  size="compact"
                  variant="ghost"
                  className="w-auto min-w-0"
                >
                  <SelectValue>{filters.team ?? "Team"}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem value={ANY}>Any team</SelectItem>
                  {teams.map((team) => (
                    <SelectItem key={team} value={team}>
                      {team}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            {tags.length > 0 ? (
              <Select
                value={filters.tag ?? ANY}
                onValueChange={(value) => setFilters({ tag: value === ANY ? null : String(value) })}
              >
                <SelectTrigger
                  aria-label="Tag"
                  size="compact"
                  variant="ghost"
                  className="w-auto min-w-0"
                >
                  <SelectValue>{filters.tag ? `#${filters.tag}` : "Tag"}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem value={ANY}>Any tag</SelectItem>
                  {tags.map((tag) => (
                    <SelectItem key={tag} value={tag}>
                      #{tag}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
          </div>
        </Group>
        {/* What is on is shown whether the filters are folded or not. */}
        <ActiveFilterChips
          filters={filters}
          laneTitle={laneTitle}
          shown={kept.length}
          onClear={(patch) => setFilters(patch)}
          onReset={clearFilters}
        />
      </SidebarGroup>

      <SidebarGroup className="gap-1 px-[var(--sidebar-content-inset)] pt-0">
        {!environmentId ? (
          <p className="px-2 text-xs text-sidebar-muted-foreground">
            {isReady ? "This environment is unavailable." : "Loading environments..."}
          </p>
        ) : !enabled ? (
          <p className="px-2 text-xs text-sidebar-muted-foreground">
            Delivery is turned off for this environment.
          </p>
        ) : read.error ? (
          <EngineDownNotice
            className="px-2 text-xs"
            environmentId={environmentId}
            message={`Delivery engine not reachable. ${read.error}`}
          />
        ) : searching ? (
          <Section
            environmentId={environmentId}
            name="found"
            title="Found"
            cards={kept}
            empty={unread ?? "No task matches."}
            now={now}
            selected={selected}
            onOpen={open}
          />
        ) : (
          <>
            <Section
              environmentId={environmentId}
              name="waiting"
              title="Waiting on you"
              cards={waiting}
              empty={unread ?? "Nothing waits for you."}
              now={now}
              selected={selected}
              onOpen={open}
            />
            <Section
              environmentId={environmentId}
              name="working"
              title="Being worked on"
              cards={working}
              now={now}
              selected={selected}
              onOpen={open}
            />
            <Section
              environmentId={environmentId}
              name="chats"
              title="Team chats"
              cards={chats}
              now={now}
              selected={selected}
              onOpen={open}
            />
            <Section
              environmentId={environmentId}
              name="drafts"
              title="Drafts"
              cards={kept.filter((card) => card.lane === "draft")}
              now={now}
              selected={selected}
              onOpen={open}
            />
            <Section
              environmentId={environmentId}
              name="open"
              title="With the team"
              cards={rest}
              now={now}
              selected={selected}
              onOpen={open}
            />
            <Section
              environmentId={environmentId}
              name="done"
              title="Done"
              cards={kept.filter((card) => card.lane === "completed").slice(0, 20)}
              now={now}
              selected={selected}
              onOpen={open}
              defaultFolded
            />
          </>
        )}
      </SidebarGroup>
      <p
        className="mt-auto px-[calc(var(--sidebar-content-inset)+0.5rem)] pb-2 font-mono text-[10px] text-sidebar-muted-foreground"
        data-app-build={APP_BUILD}
      >
        build {APP_BUILD}
      </p>
    </SidebarContent>
  );
}
