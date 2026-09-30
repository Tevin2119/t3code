import { Columns3Icon, XIcon } from "lucide-react";

import { activeFilters, type BoardFilters } from "../../lib/deliveryBoard";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
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
