import { ChevronDownIcon, LayersIcon, PencilIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { parseRepositories, targetLine, type DeliveryTarget } from "../../lib/delivery";
import { useDeliveryAct, useDeliveryRead } from "../../state/delivery";

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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  selectTriggerVariants,
} from "../ui/select";
import { Textarea } from "../ui/textarea";

export interface PickerItem {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** "own" for one a person made, which can be renamed or removed. */
  readonly kind: string;
  readonly count?: number | null;
  /** For a board: the repository and base branch its tasks are done in. */
  readonly target?: DeliveryTarget | null;
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
                {item.kind === "own" && item.target !== undefined ? (
                  <span
                    className={`truncate text-[11px] ${item.target?.ok ? "text-muted-foreground" : "text-warning"}`}
                    data-board-picker-target={item.target?.ok ? "ok" : "none"}
                  >
                    {targetLine(item.target ?? null)}
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

const ADD_REPOSITORY = "__add_repository__";

/**
 * Makes or edits a board or a view: a name and what it is for, for a board the repository and
 * base branch its tasks are done in, and for a view the columns it shows. Removing says what
 * becomes of what it held.
 */
export function BoardDialog(props: {
  readonly kind: "board" | "view";
  readonly editing: PickerItem | null;
  /** For a board: where the repositories are read and added. */
  readonly environmentId?: EnvironmentId | null;
  readonly by?: string;
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
    readonly repository?: string;
    readonly base?: string;
  }) => void;
  readonly onRemove?: () => void;
}) {
  const [title, setTitle] = useState(props.editing?.title ?? "");
  const [description, setDescription] = useState(props.editing?.description ?? "");
  const [lanes, setLanes] = useState<ReadonlyArray<string>>(props.chosenColumns ?? []);
  const [confirming, setConfirming] = useState(false);
  const noun = props.kind === "board" ? "board" : "view";
  // A board is bound to a repository and a base branch. Its name, left empty, is the repository's.
  const isBoard = props.kind === "board";
  const reposRead = useDeliveryRead(
    isBoard ? (props.environmentId ?? null) : null,
    "/api/repositories",
  );
  const repositories = useMemo(
    () => parseRepositories(reposRead.body).filter((item) => item.kind !== "qualification"),
    [reposRead.body],
  );
  const addAct = useDeliveryAct(props.environmentId ?? null, "add repository");
  const [repository, setRepository] = useState(props.editing?.target?.repository ?? "");
  const [base, setBase] = useState(props.editing?.target?.base ?? "");
  const [adding, setAdding] = useState(false);
  const [folder, setFolder] = useState("");
  const [repoName, setRepoName] = useState("");
  const folderName =
    folder
      .trim()
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  const [addProblem, setAddProblem] = useState<string | null>(null);
  const chosen = repositories.find((item) => item.id === repository) ?? null;
  const name = title.trim() || (isBoard && !props.editing ? (chosen?.title ?? "") : "");
  const wasBound = Boolean(props.editing?.target?.repository);
  const bindingChanged =
    repository !== (props.editing?.target?.repository ?? "") ||
    base !== (props.editing?.target?.base ?? "");
  const needsBinding = isBoard && (!props.editing || wasBound || bindingChanged);
  const bindingReady = !needsBinding || (Boolean(repository) && Boolean(base));
  const addRepository = async () => {
    setAddProblem(null);
    const result = await addAct("/api/repositories", {
      path: folder.trim(),
      title: repoName.trim() || folderName,
      by: props.by,
    });
    if (!result.ok) {
      setAddProblem(result.why);
      return;
    }
    const made = result.body as { readonly id?: string; readonly defaultBase?: string } | null;
    reposRead.refresh();
    if (made?.id) {
      setRepository(made.id);
      setBase(made.defaultBase ?? "");
    }
    setAdding(false);
    setFolder("");
    setRepoName("");
  };
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
          {isBoard ? (
            <div className="flex flex-col gap-2" data-board-dialog-binding>
              {props.editing && !wasBound ? (
                <p className="text-xs text-warning" data-board-dialog-unbound>
                  Repository not configured. Choose one: tasks filed on this board from now on are
                  done there. Tasks already on it keep what they have.
                </p>
              ) : null}
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">Repository</span>
                <Select
                  value={repository || null}
                  onValueChange={(value) => {
                    if (value === ADD_REPOSITORY) {
                      setAdding(true);
                      return;
                    }
                    const next = repositories.find((item) => item.id === value);
                    setRepository(String(value ?? ""));
                    setBase(next?.defaultBase ?? "");
                  }}
                >
                  <SelectTrigger
                    aria-label="Repository"
                    size="compact"
                    data-board-dialog-repository
                  >
                    <SelectValue placeholder="Choose the repository its tasks are done in">
                      {chosen ? chosen.title : undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    <SelectItem value={ADD_REPOSITORY}>
                      <PlusIcon className="size-3.5" />
                      Add a repository by its folder…
                    </SelectItem>
                    {repositories.map((item) => (
                      <SelectItem key={item.id} value={item.id} disabled={!item.ok}>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{item.title}</span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {item.ok ? item.path : item.problem}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              {adding ? (
                <div className="flex flex-col gap-1 rounded-md border border-border p-2">
                  <Input
                    aria-label="Folder of the repository"
                    placeholder="C:/path/to/the/repository"
                    value={folder}
                    onChange={(event) => setFolder(event.target.value)}
                    data-board-dialog-folder
                  />
                  <Input
                    aria-label="Name of the repository"
                    placeholder={folderName ? `Name (${folderName})` : "Name of the repository"}
                    value={repoName}
                    onChange={(event) => setRepoName(event.target.value)}
                    data-board-dialog-repository-name
                  />
                  <span className="text-[11px] text-muted-foreground">
                    The folder is read, not changed. Work is done in worktrees made beside it.
                  </span>
                  {addProblem ? <span className="text-xs text-warning">{addProblem}</span> : null}
                  <span className="flex justify-end gap-2">
                    <Button size="xs" variant="ghost" onClick={() => setAdding(false)}>
                      Cancel
                    </Button>
                    <Button
                      size="xs"
                      disabled={!folder.trim()}
                      onClick={() => void addRepository()}
                      data-board-dialog-add-repository
                    >
                      Add repository
                    </Button>
                  </span>
                </div>
              ) : null}
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">Base branch</span>
                <Select
                  value={base || null}
                  onValueChange={(value) => setBase(String(value ?? ""))}
                  disabled={!chosen}
                >
                  <SelectTrigger aria-label="Base branch" size="compact" data-board-dialog-base>
                    <SelectValue placeholder="Choose a repository first">
                      {base || undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {(chosen?.branches ?? []).map((branch) => (
                      <SelectItem key={branch} value={branch}>
                        {branch}
                        {branch === chosen?.defaultBase ? (
                          <span className="text-[11px] text-muted-foreground"> (default)</span>
                        ) : null}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <span className="text-[11px] text-muted-foreground">
                  Work on a task starts from this branch. The team works in a worktree of its own;
                  the branch itself is not changed.
                </span>
              </label>
            </div>
          ) : null}
          <Input
            aria-label="Name"
            placeholder={isBoard && chosen && !props.editing ? chosen.title : "Name"}
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
                props.busy ||
                !name ||
                (props.kind === "view" && lanes.length === 0) ||
                !bindingReady
              }
              onClick={() =>
                props.onSave({
                  title: name,
                  description: description.trim(),
                  ...(props.kind === "view" ? { lanes } : {}),
                  ...(isBoard && repository && base && (!props.editing || bindingChanged)
                    ? { repository, base }
                    : {}),
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
