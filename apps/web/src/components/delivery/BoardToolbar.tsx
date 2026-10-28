import type { EnvironmentId } from "@t3tools/contracts";
import { FilterIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { TASK_PRIORITIES, type DeliveryCard, type TaskPriority } from "../../lib/delivery";
import {
  BOARD_GROUPINGS,
  GROUPING_LABEL,
  NO_FILTERS,
  PRIORITY_LABEL,
  hasFilters,
  tagChoices,
  type BoardFilters,
  type BoardGrouping,
} from "../../lib/deliveryBoard";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LaneFilterMenu, TagFilterMenu, type LaneChoice } from "./BoardFilterControls";
import { EnginePanel } from "./EnginePanel";

const desktopQuery = "(min-width: 768px)";
const subscribe = (notify: () => void) => {
  const query = window.matchMedia(desktopQuery);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
const getDesktop = () => window.matchMedia(desktopQuery).matches;
export const useBoardDesktop = () => useSyncExternalStore(subscribe, getDesktop, () => true);

function boardToolbarFiltered(
  filters: BoardFilters,
  grouping: BoardGrouping,
  view: string,
  environmentChanged: boolean,
) {
  return (
    environmentChanged ||
    grouping !== "none" ||
    view !== "development" ||
    hasFilters({ ...filters, q: NO_FILTERS.q })
  );
}

export interface BoardToolbarProps {
  readonly environmentId: EnvironmentId | null;
  readonly environmentPicker: ReactNode;
  readonly boardPicker: ReactNode;
  readonly viewPicker: ReactNode;
  readonly help: ReactNode;
  readonly filters: BoardFilters;
  readonly grouping: BoardGrouping;
  readonly view: string;
  readonly environmentChanged: boolean;
  readonly cards: ReadonlyArray<DeliveryCard>;
  readonly lanes: ReadonlyArray<LaneChoice>;
  readonly waiting: number;
  readonly shared: boolean;
  readonly enabled: boolean;
  readonly status: string;
  readonly pending: boolean;
  readonly onFilters: (patch: Partial<BoardFilters>) => void;
  readonly onGrouping: (grouping: BoardGrouping) => void;
  readonly onReset: () => void;
  readonly onNew: () => void;
  readonly onRefresh: () => void;
}

export function BoardToolbar(props: BoardToolbarProps) {
  const desktop = useBoardDesktop();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const portal = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  const { filters } = props;
  const filtered = props.shared
    ? props.environmentChanged
    : boardToolbarFiltered(filters, props.grouping, props.view, props.environmentChanged);
  const closeSearch = () => {
    setSearchOpen(false);
    searchButton.current?.focus();
  };
  const choices = (field: "team" | "owner") =>
    [
      ...new Set([
        ...props.cards.map((card) => card[field]).filter(Boolean),
        ...(filters[field] ? [filters[field]] : []),
      ]),
    ].sort();

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 py-2 md:flex-wrap" data-board-toolbar>
      <h1 className="hidden text-sm font-medium md:block">Board</h1>
      <div className="order-0 flex w-9 shrink-0 justify-center md:order-2 md:w-auto">
        {props.environmentId ? (
          <EnginePanel environmentId={props.environmentId} compact={!desktop} />
        ) : null}
      </div>
      <div
        className={`order-1 min-w-0 flex-1 md:order-3 md:flex-none ${searchOpen ? "max-md:hidden" : ""}`}
      >
        {props.boardPicker}
      </div>
      <div className="order-2 flex w-9 shrink-0 justify-center md:hidden">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                ref={filterButton}
                size="icon-sm"
                variant={filtered ? "secondary" : "ghost"}
                aria-label={filtered ? "Board filters active" : "Board filters"}
                aria-description={props.waiting > 0 ? `${props.waiting} waiting on you` : undefined}
                aria-expanded={sheetOpen}
                onClick={() => setSheetOpen((open) => !open)}
              />
            }
          >
            <FilterIcon />
            {filtered ? (
              <span className="absolute -top-1 -right-1">
                <Badge size="sm" aria-label="Active filters">
                  •
                </Badge>
              </span>
            ) : null}
            {props.waiting > 0 ? (
              <span className="absolute -right-2 -bottom-2">
                <Badge size="sm" variant="warning" aria-label={`${props.waiting} waiting on you`}>
                  {props.waiting > 99 ? "99+" : props.waiting}
                </Badge>
              </span>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup>Board filters</TooltipPopup>
        </Tooltip>
      </div>
      <Sheet open={!desktop && sheetOpen} modal={!desktop} onOpenChange={setSheetOpen}>
        {/* The portal destination and every control ancestor stay fixed across the breakpoint. */}
        <div ref={portal} className="contents" />
        <SheetPopup
          container={portal}
          keepMounted
          inline={desktop}
          side="bottom"
          transitionDurationMs={0}
          finalFocus={filterButton}
          aria-label="Board filters"
        >
          <div className="md:hidden">
            <SheetHeader>
              <SheetTitle>Board filters</SheetTitle>
            </SheetHeader>
          </div>
          <div className="flex max-h-[75dvh] flex-col items-start gap-3 overflow-y-auto p-6 md:contents">
            <div className="md:order-1">{props.environmentPicker}</div>
            {!props.shared ? (
              <>
                <div className="md:order-4">{props.viewPicker}</div>
                <div className="md:order-6">
                  <Select
                    value={props.grouping}
                    onValueChange={(value) => value && props.onGrouping(value as BoardGrouping)}
                  >
                    <SelectTrigger
                      aria-label="Group cards by"
                      size="compact"
                      variant="ghost"
                      className="w-auto min-w-0"
                    >
                      <SelectValue>
                        {props.grouping === "none"
                          ? "Group"
                          : `By ${GROUPING_LABEL[props.grouping].toLowerCase()}`}
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
                </div>
                <div className="md:order-7">
                  <LaneFilterMenu
                    lanes={props.lanes}
                    chosen={filters.lanes}
                    onChange={(lanes) => props.onFilters({ lanes })}
                  />
                </div>
                <div className={`md:order-8 ${props.waiting === 0 ? "md:hidden" : ""}`}>
                  <Button
                    size="xs"
                    variant={filters.waiting ? "secondary" : "ghost"}
                    aria-pressed={filters.waiting}
                    onClick={() => props.onFilters({ waiting: !filters.waiting })}
                    data-board-waiting
                  >
                    <span className="text-warning-foreground">{props.waiting} waiting on you</span>
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2 md:hidden">
                  <Select
                    value={filters.priority ?? "any"}
                    onValueChange={(value) =>
                      props.onFilters({
                        priority: value === "any" ? null : (value as TaskPriority),
                      })
                    }
                  >
                    <SelectTrigger aria-label="Priority" size="compact" variant="ghost">
                      <SelectValue>
                        {filters.priority ? PRIORITY_LABEL[filters.priority] : "Priority"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      <SelectItem value="any">Any priority</SelectItem>
                      {TASK_PRIORITIES.map((priority) => (
                        <SelectItem key={priority} value={priority}>
                          {PRIORITY_LABEL[priority]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  {(["team", "owner"] as const).map((field) => (
                    <Select
                      key={field}
                      value={filters[field] ?? ""}
                      onValueChange={(value) => props.onFilters({ [field]: value || null })}
                    >
                      <SelectTrigger
                        aria-label={field === "team" ? "Team" : "Owner"}
                        size="compact"
                        variant="ghost"
                      >
                        <SelectValue>
                          {filters[field] ?? (field === "team" ? "Team" : "Owner")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        <SelectItem value="">
                          {field === "team" ? "Any team" : "Any owner"}
                        </SelectItem>
                        {choices(field).map((item) => (
                          <SelectItem key={item} value={item}>
                            {item}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  ))}
                  <TagFilterMenu
                    tags={tagChoices([props.cards], filters.tags)}
                    chosen={filters.tags}
                    onChange={(tags) => props.onFilters({ tags })}
                  />
                  <Button size="xs" variant="ghost" onClick={props.onReset}>
                    Clear filters
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </SheetPopup>
      </Sheet>
      <div
        className={`order-3 flex min-w-0 items-center md:order-5 ${searchOpen ? "flex-1" : ""} ${props.shared ? "hidden" : ""}`}
      >
        <div className={searchOpen ? "min-w-0 flex-1 md:flex-none" : "hidden md:block"}>
          <InputGroup className="h-7 min-w-0 md:w-64">
            <InputGroupAddon>
              <SearchIcon className="size-3.5 text-muted-foreground" />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchInput}
              size="compact"
              aria-label="Search tasks"
              placeholder="Search by #number, title, tag, owner"
              value={filters.q}
              onChange={(event) => props.onFilters({ q: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !desktop) {
                  event.preventDefault();
                  closeSearch();
                }
              }}
            />
          </InputGroup>
        </div>
        <div className="flex w-9 shrink-0 justify-center md:hidden">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  ref={searchButton}
                  size="icon-sm"
                  variant={filters.q ? "secondary" : "ghost"}
                  aria-label={searchOpen ? "Close board search" : "Search the board"}
                  aria-expanded={searchOpen}
                  onClick={() => {
                    if (searchOpen) closeSearch();
                    else {
                      setSearchOpen(true);
                      requestAnimationFrame(() => searchInput.current?.focus());
                    }
                  }}
                />
              }
            >
              {searchOpen ? <XIcon /> : <SearchIcon />}
            </TooltipTrigger>
            <TooltipPopup>{searchOpen ? "Close board search" : "Search the board"}</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      <div className="order-4 ml-auto flex shrink-0 items-center gap-1 md:order-9">
        {!props.shared ? (
          <span className="hidden font-mono text-3xs text-muted-foreground md:inline">
            {props.status}
          </span>
        ) : null}
        <div className="flex w-9 justify-center md:w-auto">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size={desktop ? "xs" : "icon-sm"}
                  disabled={!props.enabled}
                  aria-label="New task"
                  onClick={props.onNew}
                  data-board-new-task
                />
              }
            >
              <PlusIcon />
              <span className="hidden md:inline">New task</span>
            </TooltipTrigger>
            <TooltipPopup>New task</TooltipPopup>
          </Tooltip>
        </div>
        <div className="hidden md:contents">{props.help}</div>
        {!props.shared ? (
          <div className="hidden md:contents">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh board"
              onClick={props.onRefresh}
            >
              <RefreshIcon className="size-3.5" refreshing={props.pending} />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
