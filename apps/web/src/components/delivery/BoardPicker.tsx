import { ChevronDownIcon, LayersIcon, PencilIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  parseRepositories,
  targetLine,
  type DeliveryRepository,
  type DeliveryTarget,
} from "../../lib/delivery";
import { useDeliveryAct, useDeliveryRead } from "../../state/delivery";
import { useProjects } from "../../state/entities";
import {
  PROJECT_CHOICE_PREFIX,
  addedRepository,
  knownRepositories,
  repositoryChoices,
  repositoryInFolder,
  type RepositoryChoice,
} from "./BoardPicker.repositories";
import { RepositoryBrowse } from "./BoardPicker.browse";
import { BaseBranchPicker } from "./BoardPicker.branches";

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
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  SelectButton,
} from "../ui/select";
import { Textarea } from "../ui/textarea";

export interface PickerItem {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** "own" for one a person made, which can be renamed or removed. */
  readonly kind: string;
  readonly scope?: "local" | "shared";
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
            <SelectButton
              aria-label={props.label}
              size="compact"
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
      <PopoverPopup padding="none" align="start" className="w-80 max-w-[calc(100vw-2rem)] ">
        <div className="flex items-center gap-1 border-b border-border p-2">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={`Search ${props.label.toLowerCase()}`}
              placeholder="Search"
              size="sm"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              data-board-picker-search
            />
          </InputGroup>
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
                  {item.scope || item.kind === "own" ? (
                    <span className="ml-auto text-3xs text-muted-foreground">
                      {item.scope ?? "yours"}
                    </span>
                  ) : null}
                </span>
                {item.description ? (
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {item.description}
                  </span>
                ) : null}
                {item.kind === "own" && item.target !== undefined ? (
                  <span
                    className={`truncate text-2xs ${item.target?.ok ? "text-muted-foreground" : "text-warning"}`}
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
  readonly workspace?: string | null;
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
    readonly workspace?: string;
  }) => void;
  readonly onRemove?: () => void;
  /** For a board being edited: opens what its seats run on. */
  readonly onSeats?: () => void;
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
  // Repositories the engine has added here and not yet listed, so they can be chosen at once.
  const [added, setAdded] = useState<ReadonlyArray<DeliveryRepository>>([]);
  const known = useMemo(
    () => knownRepositories(parseRepositories(reposRead.body), added),
    [reposRead.body, added],
  );
  const repositories = useMemo(
    () => known.filter((item) => item.kind !== "qualification"),
    [known],
  );
  // T3's own projects in this environment are offered too, and added to the engine when chosen.
  const projects = useProjects();
  const choices = useMemo(
    () =>
      isBoard
        ? repositoryChoices({ repositories: known, projects, environmentId: props.environmentId })
        : [],
    [isBoard, known, projects, props.environmentId],
  );
  const projectChoices = choices.filter((choice) => choice.kind === "project");
  // A project is added only once the engine's list is read, so one it has is never added again.
  const projectBlocked = reposRead.error
    ? "The engine's repositories could not be read, so this cannot be added."
    : reposRead.body === null && reposRead.isPending
      ? "Reading the engine's repositories…"
      : null;
  const addAct = useDeliveryAct(props.environmentId ?? null, "add repository");
  const [repository, setRepository] = useState(props.editing?.target?.repository ?? "");
  const [base, setBase] = useState(props.editing?.target?.base ?? "");
  const [adding, setAdding] = useState(false);
  // The name of the repository being added; nothing else is chosen meanwhile.
  const [registering, setRegistering] = useState<string | null>(null);
  const registeringRef = useRef(false);
  const [chooseProblem, setChooseProblem] = useState<string | null>(null);
  // An add that ends after the dialog closed or its environment changed is let go.
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
      registeringRef.current = false;
      setRegistering(null);
      setAdded([]);
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Resets when the environment changes.
    [props.environmentId],
  );
  // A board can instead be bound to a T3 project folder that is not a repository: chat and
  // non-code work, which the engine runs in that folder without Git.
  const initialWorkspace = props.editing
    ? props.editing.target?.repository
      ? ""
      : (props.editing.target?.path ?? "")
    : (props.workspace ?? "");
  const [binding, setBinding] = useState(initialWorkspace ? "workspace" : "repository");
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const projectFolders = [
    ...new Map([
      ...projects
        .filter((project) => project.environmentId === props.environmentId)
        .map((project) => [project.workspaceRoot, project.title] as const),
      ...(initialWorkspace
        ? [[initialWorkspace, initialWorkspace.split(/[\\/]/).pop() ?? initialWorkspace] as const]
        : []),
    ]).entries(),
  ];
  const [addProblem, setAddProblem] = useState<string | null>(null);
  const chosen = repositories.find((item) => item.id === repository) ?? null;
  const name =
    title.trim() ||
    (isBoard && !props.editing
      ? binding === "workspace"
        ? (projectFolders.find(([folder]) => folder === workspace)?.[1] ?? "")
        : (chosen?.title ?? "")
      : "");
  const wasBound = Boolean(props.editing?.target?.repository);
  const bindingChanged =
    binding !==
      (props.editing?.target?.path && !props.editing.target.repository
        ? "workspace"
        : "repository") ||
    workspace !== (props.editing?.target?.repository ? "" : (props.editing?.target?.path ?? "")) ||
    repository !== (props.editing?.target?.repository ?? "") ||
    base !== (props.editing?.target?.base ?? "");
  const needsBinding = isBoard && (!props.editing || wasBound || bindingChanged);
  const bindingReady =
    binding === "workspace"
      ? Boolean(workspace)
      : !needsBinding || (Boolean(repository) && Boolean(base));
  const select = (item: DeliveryRepository) => {
    setRepository(item.id);
    setBase(item.defaultBase ?? "");
  };
  /** Adds a folder to the engine; null when the answer came too late to be used. */
  const register = async (
    path: string,
    repositoryTitle: string,
  ): Promise<
    | { readonly ok: true; readonly repository: DeliveryRepository }
    | { readonly ok: false; readonly why: string }
    | null
  > => {
    const at = generation.current;
    registeringRef.current = true;
    setRegistering(repositoryTitle);
    try {
      const result = await addAct("/api/repositories", {
        path,
        title: repositoryTitle,
        by: props.by,
      });
      if (at !== generation.current) return null;
      if (!result.ok) return { ok: false, why: result.why };
      reposRead.refresh();
      const made = addedRepository(result.body, { path, title: repositoryTitle });
      if (!made) {
        return {
          ok: false,
          why: `${repositoryTitle} was added, but the engine did not say which repository it is. Choose it once the list is read again.`,
        };
      }
      setAdded((current) => [...current.filter((item) => item.id !== made.id), made]);
      return { ok: true, repository: made };
    } finally {
      if (at === generation.current) {
        registeringRef.current = false;
        setRegistering(null);
      }
    }
  };
  const repositoryTrigger = useRef<HTMLButtonElement>(null);
  const baseTrigger = useRef<HTMLButtonElement>(null);
  // Where focus goes once the add form closes: back to the list, or on to the added one's branch.
  const focusAfterAdd = useRef<"repository" | "base" | null>(null);
  useEffect(() => {
    if (adding || !focusAfterAdd.current) return;
    (focusAfterAdd.current === "base" ? baseTrigger : repositoryTrigger).current?.focus();
    focusAfterAdd.current = null;
  }, [adding]);
  const addRepository = async (path: string, repositoryTitle: string) => {
    if (registeringRef.current || !path || !repositoryTitle.trim()) return;
    setAddProblem(null);
    setChooseProblem(null);
    const outcome = await register(path, repositoryTitle.trim());
    if (!outcome) return;
    if (!outcome.ok) {
      setAddProblem(outcome.why);
      return;
    }
    select(outcome.repository);
    focusAfterAdd.current = "base";
    setAdding(false);
  };
  /** Closes the add form. An add still going is let go here, though the engine may finish it. */
  const cancelAdd = () => {
    generation.current += 1;
    registeringRef.current = false;
    setRegistering(null);
    setAddProblem(null);
    focusAfterAdd.current = "repository";
    setAdding(false);
  };
  const choiceFor = (value: string): RepositoryChoice | null => {
    const listed = choices.find((choice) => choice.value === value);
    if (listed) return listed;
    // A project row chosen again after its add: the engine has its folder now.
    const project = value.startsWith(PROJECT_CHOICE_PREFIX)
      ? projects.find((item) => `${PROJECT_CHOICE_PREFIX}${item.id}` === value)
      : undefined;
    const same = project ? repositoryInFolder(known, project.workspaceRoot) : null;
    return same ? { kind: "engine", value: same.id, repository: same } : null;
  };
  const chooseRepository = async (value: string) => {
    if (registeringRef.current) return;
    setChooseProblem(null);
    if (value === ADD_REPOSITORY) {
      setAddProblem(null);
      setAdding(true);
      return;
    }
    const choice = choiceFor(value);
    if (!choice) return;
    if (choice.kind === "engine") {
      select(choice.repository);
      return;
    }
    if (projectBlocked) {
      setChooseProblem(projectBlocked);
      return;
    }
    setRepository("");
    setBase("");
    setAddProblem(null);
    const outcome = await register(choice.folder, choice.name);
    if (!outcome) return;
    if (!outcome.ok) {
      setChooseProblem(outcome.why);
      return;
    }
    select(outcome.repository);
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
        <DialogPanel className="flex flex-col ">
          {isBoard ? (
            <div className="flex flex-col gap-2" data-board-dialog-binding>
              <label className="flex items-center gap-2 text-xs" data-board-dialog-workspace-mode>
                <Checkbox
                  checked={binding === "workspace"}
                  onCheckedChange={(on) => setBinding(on ? "workspace" : "repository")}
                />
                Chat and non-code work in a project folder, with no repository
              </label>
              {binding === "workspace" ? (
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium">Project folder</span>
                  <Select
                    value={workspace || null}
                    onValueChange={(value) => setWorkspace(String(value ?? ""))}
                  >
                    <SelectTrigger aria-label="Board project folder" size="compact">
                      <SelectValue placeholder="Choose a T3 project">
                        {projectFolders.find(([folder]) => folder === workspace)?.[1]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {projectFolders.map(([folder, name]) => (
                        <SelectItem key={folder} value={folder}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <span className="text-2xs text-muted-foreground">
                    {workspace || "Add a project using T3's project picker first."} No Git
                    repository is created. Submitted tasks keep their existing work folder.
                  </span>
                </label>
              ) : (
                <>
                  {props.editing && !wasBound ? (
                    <p className="text-xs text-warning" data-board-dialog-unbound>
                      Repository not configured. Choose one: tasks filed on this board from now on
                      are done there. Tasks already on it keep what they have.
                    </p>
                  ) : null}
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium">Repository</span>
                    <Select
                      value={repository || null}
                      onValueChange={(value) => void chooseRepository(String(value ?? ""))}
                      disabled={registering !== null}
                    >
                      <SelectTrigger
                        ref={repositoryTrigger}
                        aria-label="Repository"
                        size="compact"
                        data-board-dialog-repository
                      >
                        <SelectValue placeholder="Choose the repository its tasks are done in">
                          {chosen ? chosen.title : (registering ?? undefined)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        <SelectItem value={ADD_REPOSITORY}>
                          <PlusIcon className="size-3.5" />
                          Add a repository by its folder…
                        </SelectItem>
                        {repositories.map((item) => (
                          <SelectItem
                            key={item.id}
                            value={item.id}
                            label={item.title}
                            disabled={!item.ok}
                          >
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{item.title}</span>
                              <span className="truncate text-2xs text-muted-foreground">
                                {item.path}
                              </span>
                              {item.ok ? null : (
                                <span className="truncate text-2xs text-warning">
                                  {item.problem ?? "It cannot be read."}
                                </span>
                              )}
                            </span>
                          </SelectItem>
                        ))}
                        {projectChoices.length > 0 ? (
                          <SelectGroup>
                            <SelectGroupLabel>
                              T3 projects, added to the engine when chosen
                            </SelectGroupLabel>
                            {projectChoices.map((choice) =>
                              choice.kind === "project" ? (
                                <SelectItem
                                  key={choice.value}
                                  value={choice.value}
                                  label={choice.name}
                                  disabled={projectBlocked !== null}
                                  data-board-dialog-project={choice.folder}
                                >
                                  <span className="flex min-w-0 flex-col">
                                    <span className="truncate">{choice.name}</span>
                                    <span className="truncate text-2xs text-muted-foreground">
                                      {choice.folder}
                                    </span>
                                    {projectBlocked ? (
                                      <span className="truncate text-2xs text-muted-foreground">
                                        {projectBlocked}
                                      </span>
                                    ) : null}
                                  </span>
                                </SelectItem>
                              ) : null,
                            )}
                          </SelectGroup>
                        ) : null}
                      </SelectPopup>
                    </Select>
                  </label>
                  <p
                    role="alert"
                    aria-live="polite"
                    className="text-xs text-warning empty:hidden"
                    data-board-dialog-repository-problem
                  >
                    {chooseProblem}
                  </p>
                  {adding && props.environmentId ? (
                    <RepositoryBrowse
                      key={props.environmentId}
                      environmentId={props.environmentId}
                      projects={projects}
                      registering={registering !== null}
                      problem={addProblem}
                      onCancel={cancelAdd}
                      onAdd={(path, repositoryTitle) => void addRepository(path, repositoryTitle)}
                    />
                  ) : null}
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium">Base branch</span>
                    <BaseBranchPicker
                      key={`${props.environmentId ?? ""}:${chosen?.id ?? ""}`}
                      environmentId={props.environmentId ?? null}
                      cwd={chosen?.path ?? null}
                      defaultBase={chosen?.defaultBase ?? null}
                      value={base}
                      onChange={setBase}
                      disabled={!chosen || registering !== null}
                      ref={baseTrigger}
                    />
                    <span className="text-2xs text-muted-foreground">
                      Work on a task starts from this branch. The team works in a worktree of its
                      own; the branch itself is not changed.
                    </span>
                  </label>
                </>
              )}
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
          {isBoard && (registering !== null || !bindingReady) ? (
            <p className="text-xs text-muted-foreground" data-board-dialog-why>
              {registering !== null
                ? `Adding ${registering}…`
                : !repository
                  ? "Choose the repository its tasks are done in."
                  : chosen && !chosen.ok
                    ? `${chosen.title}: ${chosen.problem ?? "it cannot be read"}.`
                    : "Choose the branch work starts from."}
            </p>
          ) : null}
          {isBoard && bindingReady && chosen && !chosen.ok ? (
            <p className="text-xs text-warning" data-board-dialog-why>
              {chosen.title}: {chosen.problem ?? "it cannot be read"}. Tasks filed on this board
              cannot be submitted until it can.
            </p>
          ) : null}
          {props.kind === "view" && (!name || lanes.length === 0) ? (
            <p className="text-xs text-muted-foreground" data-board-dialog-why>
              {!name ? "Give the view a name." : "Choose at least one column."}
            </p>
          ) : null}
          {isBoard && props.editing && props.onSeats
            ? (() => {
                // Opening the seats closes this dialog: what was changed here is saved or let go first.
                const unsaved =
                  title !== (props.editing.title ?? "") ||
                  description !== (props.editing.description ?? "") ||
                  bindingChanged;
                return (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-border p-2">
                    <span className="text-xs text-muted-foreground">
                      What the seats of each team run on for this board's tasks, and who stands in
                      for them.
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={props.busy || unsaved}
                      onClick={props.onSeats}
                      data-board-dialog-seats
                    >
                      Seats…
                    </Button>
                    {unsaved ? (
                      <span className="text-2xs text-muted-foreground" data-board-dialog-seats-why>
                        Save or cancel the changes here first.
                      </span>
                    ) : null}
                  </div>
                );
              })()
            : null}
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
                registering !== null ||
                !name ||
                (props.kind === "view" && lanes.length === 0) ||
                !bindingReady
              }
              onClick={() =>
                props.onSave({
                  title: name,
                  description: description.trim(),
                  ...(props.kind === "view" ? { lanes } : {}),
                  ...(isBoard && binding === "workspace" ? { workspace } : {}),
                  ...(isBoard &&
                  binding === "repository" &&
                  repository &&
                  base &&
                  (!props.editing || bindingChanged)
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
