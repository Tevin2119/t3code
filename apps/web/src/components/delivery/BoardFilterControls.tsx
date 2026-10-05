import { Columns3Icon, XIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type RefObject } from "react";

import {
  activeFilters,
  tagFilterLabel,
  tagsMatching,
  type BoardFilters,
} from "../../lib/deliveryBoard";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/** A column of the board, as the engine names it, with the cards it holds now. */
export interface LaneChoice {
  readonly lane: string;
  readonly title: string;
  readonly count: number;
}

/** Chooses the columns of the board to show. None chosen: every column. */
export function LaneFilterMenu(props: {
  readonly lanes: ReadonlyArray<LaneChoice>;
  readonly chosen: ReadonlyArray<string>;
  readonly onChange: (lanes: ReadonlyArray<string>) => void;
  readonly className?: string;
}) {
  const { chosen } = props;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant={chosen.length > 0 ? "secondary" : "ghost"}
            className={props.className}
            aria-label="Filter by column"
            data-board-lane-filter
          />
        }
      >
        <Columns3Icon />
        {chosen.length === 0
          ? "Columns"
          : `${chosen.length} column${chosen.length === 1 ? "" : "s"}`}
      </MenuTrigger>
      <MenuPopup align="start" className="w-64">
        {/* The way back to every column comes first, before the list. */}
        {chosen.length > 0 ? (
          <>
            <MenuItem onClick={() => props.onChange([])} data-board-lane-all>
              Show every column
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        {/* A group label needs a MenuGroup around it, or Base UI throws (error 31). */}
        <MenuGroup>
          <MenuGroupLabel>Show only these columns</MenuGroupLabel>
          {props.lanes.length === 0 ? (
            <MenuItem disabled>The board has not been read yet</MenuItem>
          ) : (
            props.lanes.map((lane) => (
              <MenuCheckboxItem
                key={lane.lane}
                className="grid-cols-[1rem_minmax(0,1fr)]"
                checked={chosen.includes(lane.lane)}
                closeOnClick={false}
                onCheckedChange={(next) =>
                  props.onChange(
                    next ? [...chosen, lane.lane] : chosen.filter((item) => item !== lane.lane),
                  )
                }
                data-board-lane-choice={lane.lane}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{lane.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {lane.count}
                  </span>
                </span>
              </MenuCheckboxItem>
            ))
          )}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/**
 * What the tag filter shows while it is open. What is typed in the search is kept here only,
 * so it is gone when the dropdown closes.
 */
function TagFilterList(props: {
  readonly tags: ReadonlyArray<string>;
  readonly chosen: ReadonlyArray<string>;
  readonly onChange: (tags: ReadonlyArray<string>) => void;
  readonly searchRef: RefObject<HTMLInputElement | null>;
}) {
  const { chosen, searchRef } = props;
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const shown = tagsMatching(props.tags, search);
  const boxes = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-slot="checkbox"]') ?? []);
  const focusBox = (box: HTMLElement | undefined) => {
    box?.focus();
    box?.scrollIntoView({ block: "nearest" });
  };
  // Up and down move through the tags that are shown; up from the first goes back to the search.
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const all = boxes();
    const at = all.findIndex((box) => box === document.activeElement);
    if (event.key === "ArrowDown") focusBox(all[Math.min(at + 1, all.length - 1)]);
    else if (at <= 0) searchRef.current?.focus();
    else focusBox(all[at - 1]);
  };
  return (
    // The height is bounded here, not on the popover's viewport: the popover puts a plain block
    // between the two, which would let the list grow past the viewport instead of scrolling.
    <div className="flex max-h-[min(var(--available-height),23rem)] flex-col" data-board-tag-menu>
      {/* The search and Clear are beside the list, not in it, so they stay where they are. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border p-1.5">
        <Input
          ref={searchRef}
          type="search"
          aria-label="Search tags"
          placeholder="Search tags"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            if (event.key === "ArrowDown") focusBox(boxes()[0]);
          }}
          data-board-tag-search
        />
        <Button
          size="xs"
          variant="ghost"
          className="shrink-0"
          aria-label="Clear chosen tags"
          disabled={chosen.length === 0}
          onClick={() => {
            // Before the button is disabled, or the focus is lost to the page.
            searchRef.current?.focus();
            setSearch("");
            props.onChange([]);
          }}
          data-board-tag-clear
        >
          Clear
        </Button>
      </div>
      <div
        ref={listRef}
        role="group"
        aria-label="Tags"
        className="min-h-0 flex-1 overflow-y-auto p-1"
        onKeyDown={onListKey}
        data-board-tag-list
      >
        {shown.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground" data-board-tag-none>
            No tags match
          </p>
        ) : (
          shown.map((tag) => (
            <label
              key={tag}
              className="flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm hover:bg-accent"
              data-board-tag-choice={tag}
            >
              <Checkbox
                checked={chosen.includes(tag)}
                onCheckedChange={(next) =>
                  props.onChange(next ? [...chosen, tag] : chosen.filter((item) => item !== tag))
                }
              />
              <span className="min-w-0 flex-1 truncate">#{tag}</span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}

/** Chooses the tags to show: a card is kept when it carries any of them. None chosen: every card. */
export function TagFilterMenu(props: {
  readonly tags: ReadonlyArray<string>;
  readonly chosen: ReadonlyArray<string>;
  readonly onChange: (tags: ReadonlyArray<string>) => void;
  readonly className?: string;
}) {
  const { chosen } = props;
  const searchRef = useRef<HTMLInputElement>(null);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant={chosen.length > 0 ? "secondary" : "ghost"}
            className={cn("min-w-0 max-w-full", props.className)}
            data-board-tag-filter
          />
        }
      >
        <span className="min-w-0 truncate">{tagFilterLabel(chosen)}</span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="w-64"
        // The viewport scrolls by itself unless told otherwise; here only the list of tags does.
        viewportClassName="p-0 [--viewport-inline-padding:0px] not-data-transitioning:overflow-hidden"
        initialFocus={searchRef}
      >
        <TagFilterList
          tags={props.tags}
          chosen={chosen}
          onChange={props.onChange}
          searchRef={searchRef}
        />
      </PopoverPopup>
    </Popover>
  );
}

/** Every filter that is on, each with a way to turn it off, and one to turn them all off. */
export function ActiveFilterChips(props: {
  readonly filters: BoardFilters;
  readonly laneTitle: (lane: string) => string;
  readonly onClear: (patch: Partial<BoardFilters>) => void;
  readonly onReset: () => void;
  readonly shown?: number;
  readonly className?: string;
}) {
  const active = activeFilters(props.filters, props.laneTitle);
  if (active.length === 0) return null;
  return (
    <div
      className={cn("flex flex-wrap items-center gap-1", props.className)}
      data-board-active-filters
    >
      <span className="text-[10px] text-muted-foreground">
        {props.shown === undefined ? "Filtered by" : `${props.shown} shown, filtered by`}
      </span>
      {active.map((filter) => (
        <button
          key={filter.key}
          type="button"
          className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border border-border bg-secondary px-2 text-[11px] text-secondary-foreground hover:bg-accent"
          aria-label={`Remove the filter ${filter.label}`}
          onClick={() => props.onClear(filter.clear)}
          data-board-active-filter={filter.key}
        >
          {filter.label}
          <XIcon className="size-3" />
        </button>
      ))}
      <Button size="xs" variant="ghost" onClick={props.onReset} data-board-reset-filters>
        Reset filters
      </Button>
    </div>
  );
}
