import { useLocation, useNavigate } from "@tanstack/react-router";
import { PlusIcon, SearchIcon, UsersIcon, XIcon } from "lucide-react";
import { useMemo } from "react";

import {
  parseCards,
  TASK_PRIORITIES,
  type DeliveryCard,
  type TaskPriority,
} from "../../lib/delivery";
import { hasFilters, matchesCard, PRIORITY_LABEL, queryValue } from "../../lib/deliveryBoard";
import { cn } from "../../lib/utils";
import {
  useBoardStore,
  useDeliveryEnabled,
  useDeliveryRead,
  useMinuteClock,
} from "../../state/delivery";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { Age, CardSigns, laneTone, PriorityPill } from "./taskParts";
import { BoardIcon } from "./BoardIcon";

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
              {card.workers.map((worker) => worker.seat).join(", ")} working
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function Section(props: {
  readonly title: string;
  readonly cards: ReadonlyArray<DeliveryCard>;
  readonly empty?: string;
  readonly now: number;
  readonly selected: string | null;
  readonly onOpen: (card: DeliveryCard) => void;
  readonly name: string;
}) {
  if (props.cards.length === 0 && !props.empty) return null;
  return (
    <section data-board-panel-section={props.name}>
      <h3 className="flex items-center gap-1 px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide text-sidebar-muted-foreground uppercase">
        {props.title}
        <span className="font-mono">{props.cards.length}</span>
      </h3>
      {props.cards.length === 0 ? (
        <p className="px-2 text-xs text-sidebar-muted-foreground">{props.empty}</p>
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
    </section>
  );
}

/**
 * The sidebar while the Board or the Orchestrator is open: tasks in place of
 * threads. A task is started, found and opened from here, and what waits for
 * a person is at the top.
 */
export function BoardSidebarPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const enabled = useDeliveryEnabled(environmentId);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const location = useLocation({
    select: (at) => ({
      pathname: at.pathname,
      search: at.search as { task?: string; thread?: string },
    }),
  });
  const onOrchestrator = location.pathname === "/orchestrator";
  const selected = location.search.task ?? location.search.thread ?? null;
  const filters = useBoardStore((state) => state.filters);
  const setFilters = useBoardStore((state) => state.setFilters);
  const clearFilters = useBoardStore((state) => state.clearFilters);
  const now = useMinuteClock();

  const q = filters.q.trim();
  // The engine looks in what is asked too, which a card does not carry.
  const read = useDeliveryRead(
    enabled ? environmentId : null,
    q ? `/api/tasks?q=${queryValue(q)}&limit=100` : "/api/tasks?limit=200",
    { pollMs: 6_000 },
  );
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
    void navigate(
      onOrchestrator
        ? { to: "/orchestrator", search: { thread: card.id } }
        : { to: "/board", search: { task: card.id } },
    );
  };
  const searching = hasFilters(filters);
  const live = kept.filter((card) => !["completed", "draft", "chat"].includes(card.lane));
  const chats = kept.filter((card) => card.lane === "chat");
  const waiting = live.filter((card) => card.waitingOn === "person");
  const working = live.filter((card) => card.waitingOn !== "person" && card.workers.length > 0);
  const rest = live.filter((card) => card.waitingOn !== "person" && card.workers.length === 0);

  return (
    <SidebarContent className="overflow-x-hidden" data-board-panel>
      <SidebarGroup className="gap-2 p-[var(--sidebar-content-inset)]">
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            className="flex-1 justify-start"
            disabled={!enabled}
            onClick={() => {
              close();
              void navigate({ to: "/board", search: { new: true } });
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
              void navigate({ to: "/board" });
            }}
          >
            <BoardIcon />
          </Button>
        </div>

        <span className="relative flex items-center">
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

        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="xs"
            variant={filters.waiting ? "secondary" : "ghost"}
            aria-pressed={filters.waiting}
            onClick={() => setFilters({ waiting: !filters.waiting })}
          >
            Waiting on you
          </Button>
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
              onValueChange={(value) => setFilters({ team: value === ANY ? null : String(value) })}
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
          {searching ? (
            <Button size="xs" variant="ghost" onClick={clearFilters}>
              <XIcon />
              Clear
            </Button>
          ) : null}
        </div>
      </SidebarGroup>

      <SidebarGroup className="gap-1 px-[var(--sidebar-content-inset)] pt-0">
        {!enabled ? (
          <p className="px-2 text-xs text-sidebar-muted-foreground">
            Delivery is turned off for this environment.
          </p>
        ) : read.error ? (
          <p className="px-2 text-xs text-warning">Delivery engine not reachable. {read.error}</p>
        ) : searching ? (
          <Section
            name="found"
            title="Found"
            cards={kept}
            empty="No task matches."
            now={now}
            selected={selected}
            onOpen={open}
          />
        ) : (
          <>
            <Section
              name="waiting"
              title="Waiting on you"
              cards={waiting}
              empty="Nothing waits for you."
              now={now}
              selected={selected}
              onOpen={open}
            />
            <Section
              name="working"
              title="Being worked on"
              cards={working}
              now={now}
              selected={selected}
              onOpen={open}
            />
            <Section
              name="chats"
              title="Team chats"
              cards={chats}
              now={now}
              selected={selected}
              onOpen={open}
            />
            <Section
              name="drafts"
              title="Drafts"
              cards={kept.filter((card) => card.lane === "draft")}
              now={now}
              selected={selected}
              onOpen={open}
            />
            <Section
              name="open"
              title="With the team"
              cards={rest}
              now={now}
              selected={selected}
              onOpen={open}
            />
            <Section
              name="done"
              title="Done"
              cards={kept.filter((card) => card.lane === "completed").slice(0, 20)}
              now={now}
              selected={selected}
              onOpen={open}
            />
          </>
        )}
      </SidebarGroup>
    </SidebarContent>
  );
}
