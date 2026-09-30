import { ChevronDownIcon, LayersIcon, PencilIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { selectTriggerVariants } from "../ui/select";
import { Textarea } from "../ui/textarea";

export interface PickerItem {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** "own" for one a person made, which can be renamed or removed. */
  readonly kind: string;
  readonly count?: number | null;
}

/**
 * A choice among many that can be searched: boards, or views of the board. Everything is one
 * press away, a search is cleared in one, and a person's own entries can be edited from here.
 */
export function BoardPicker(props: {
  readonly label: string;
  readonly items: ReadonlyArray<PickerItem>;
  readonly value: string;
  /** The entry that shows everything, chosen by the icon beside the search. */
  readonly everything?: { readonly id: string; readonly label: string };
  readonly newLabel: string;
  readonly onChoose: (id: string) => void;
  readonly onCreate: () => void;
  readonly onEdit: (item: PickerItem) => void;
  readonly marker: string;
  /** "field" in a form, shaped like the form's other choices; a header button otherwise. */
  readonly look?: "field";
  /** Said under the list while a person has made none of their own. */
  readonly noneYet?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = props.items.find((item) => item.id === props.value);
  const words = query.trim().toLowerCase();
  const shown = words
    ? props.items.filter((item) =>
        `${item.title} ${item.description}`.toLowerCase().includes(words),
      )
    : props.items;
  const choose = (id: string) => {
    props.onChoose(id);
    setOpen(false);
    setQuery("");
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          props.look === "field" ? (
            <button
              type="button"
              aria-label={props.label}
              className={selectTriggerVariants({ size: "compact" })}
              data-board-picker={props.marker}
              data-board-picker-value={props.value}
            />
          ) : (
            <Button
              size="xs"
              variant="ghost"
              aria-label={props.label}
              className="max-w-48 min-w-0"
              data-board-picker={props.marker}
              data-board-picker-value={props.value}
            />
          )
        }
      >
        <span className={props.look === "field" ? "flex-1 truncate" : "truncate"}>
          {current?.title ?? props.value}
        </span>
        <ChevronDownIcon
          className={props.look === "field" ? "-me-1 size-3 opacity-50" : "size-3 opacity-60"}
          aria-hidden
        />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center gap-1 border-b border-border p-2">
          <span className="relative flex min-w-0 flex-1 items-center">
            <SearchIcon className="pointer-events-none absolute left-2 z-10 size-3.5 text-muted-foreground" />
            <Input
              aria-label={`Search ${props.label.toLowerCase()}`}
              placeholder="Search"
              className="h-7 pl-7 text-xs"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              data-board-picker-search
            />
          </span>
          {query ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Clear the search"
              onClick={() => setQuery("")}
            >
              <XIcon />
            </Button>
          ) : null}
          {props.everything ? (
            <Button
              size="icon-xs"
              variant={props.value === props.everything.id ? "outline" : "ghost"}
              aria-label={props.everything.label}
              onClick={() => props.everything && choose(props.everything.id)}
              data-board-picker-everything
            >
              <LayersIcon />
            </Button>
          ) : null}
        </div>
        {/* First and pinned: reachable however long the list below grows. */}
        <div className="border-b border-border p-1">
          <Button
            size="xs"
            variant="ghost"
            className="w-full justify-start"
            onClick={() => {
              setOpen(false);
              props.onCreate();
            }}
            data-board-picker-new={props.marker}
          >
            <PlusIcon />
            {props.newLabel}
          </Button>
        </div>
        <div
          className="flex max-h-72 flex-col overflow-y-auto p-1"
          role="listbox"
          aria-label={props.label}
        >
          {shown.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              Nothing matches.{" "}
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                onClick={() => setQuery("")}
              >
                Clear the search
              </button>
            </p>
          ) : null}
          {shown.map((item) => (
            <div
              key={item.id}
              className={`flex items-start gap-1 rounded-md ${item.id === props.value ? "bg-accent" : "hover:bg-accent/60"}`}
            >
              <button
                type="button"
                role="option"
                aria-selected={item.id === props.value}
                className="flex min-w-0 flex-1 cursor-pointer flex-col items-start px-2 py-1.5 text-left"
                onClick={() => choose(item.id)}
                data-board-picker-option={item.id}
              >
                <span className="flex w-full items-baseline gap-1.5 text-sm">
                  <span className="truncate">{item.title}</span>
                  {item.count !== undefined && item.count !== null ? (
                    <span className="text-xs text-muted-foreground tabular-nums">{item.count}</span>
                  ) : null}
                  {item.kind === "own" ? (
                    <span className="ml-auto text-[10px] text-muted-foreground">yours</span>
                  ) : null}
                </span>
                {item.description ? (
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {item.description}
                  </span>
                ) : null}
              </button>
              {item.kind === "own" ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="mt-1"
                  aria-label={`Edit ${item.title}`}
                  onClick={() => {
                    setOpen(false);
                    props.onEdit(item);
                  }}
                  data-board-picker-edit={item.id}
                >
                  <PencilIcon />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
        {props.noneYet && !words && !props.items.some((item) => item.kind === "own") ? (
          <p
            className="border-t border-border px-3 py-2 text-xs text-muted-foreground"
            data-board-picker-none-yet
          >
            {props.noneYet}
          </p>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Makes or edits a board or a view: a name and what it is for, and for a view the columns it
 * shows. Removing says what becomes of what it held.
 */
export function BoardDialog(props: {
  readonly kind: "board" | "view";
  readonly editing: PickerItem | null;
  /** For a view: every column, and the ones already chosen. */
  readonly columns?: ReadonlyArray<{ readonly lane: string; readonly title: string }>;
  readonly chosenColumns?: ReadonlyArray<string>;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onClose: () => void;
  readonly onSave: (input: {
    readonly title: string;
    readonly description: string;
    readonly lanes?: ReadonlyArray<string>;
  }) => void;
  readonly onRemove?: () => void;
}) {
  const [title, setTitle] = useState(props.editing?.title ?? "");
  const [description, setDescription] = useState(props.editing?.description ?? "");
  const [lanes, setLanes] = useState<ReadonlyArray<string>>(props.chosenColumns ?? []);
  const [confirming, setConfirming] = useState(false);
  const noun = props.kind === "board" ? "board" : "view";
  return (
    <Dialog open onOpenChange={(open) => (!open && !props.busy ? props.onClose() : undefined)}>
      <DialogPopup className="max-w-lg" data-board-dialog={props.kind}>
        <DialogHeader>
          <DialogTitle>{props.editing ? `Edit ${noun}` : `New ${noun}`}</DialogTitle>
          <DialogDescription>
            {props.kind === "board"
              ? "A board is a section of work of its own. It starts empty; a task you make while it is chosen is on it, and a task can be moved to another board."
              : "A view shows the board's columns you choose, for whichever board is chosen."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <Input
            aria-label="Name"
            placeholder="Name"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Textarea
            aria-label="What it is for"
            placeholder="What it is for"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          {props.kind === "view" ? (
            <div className="grid grid-cols-2 gap-1" role="group" aria-label="Columns">
              {(props.columns ?? []).map((column) => (
                <label key={column.lane} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={lanes.includes(column.lane)}
                    onCheckedChange={(on) =>
                      setLanes((current) =>
                        on
                          ? [...current, column.lane]
                          : current.filter((lane) => lane !== column.lane),
                      )
                    }
                  />
                  {column.title}
                </label>
              ))}
            </div>
          ) : null}
          {props.problem ? <p className="text-xs text-warning">{props.problem}</p> : null}
          {confirming ? (
            <p className="rounded-md border border-border bg-muted/40 p-2 text-xs">
              {props.kind === "board"
                ? "Removing the board removes no task: its tasks are then on no board, and can be put on another."
                : "Removing the view removes no task; the board is then seen in another view."}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare" className="items-center sm:justify-between">
          {props.editing && props.onRemove ? (
            <Button
              variant="ghost"
              disabled={props.busy}
              onClick={() => (confirming ? props.onRemove?.() : setConfirming(true))}
              data-board-dialog-remove
            >
              {confirming ? `Remove the ${noun}` : `Remove ${noun}…`}
            </Button>
          ) : (
            <span />
          )}
          <span className="flex gap-2">
            <Button variant="ghost" disabled={props.busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              disabled={
                props.busy || !title.trim() || (props.kind === "view" && lanes.length === 0)
              }
              onClick={() =>
                props.onSave({
                  title: title.trim(),
                  description: description.trim(),
                  ...(props.kind === "view" ? { lanes } : {}),
                })
              }
              data-board-dialog-save
            >
              {props.editing ? "Save" : `Make ${noun}`}
            </Button>
          </span>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
