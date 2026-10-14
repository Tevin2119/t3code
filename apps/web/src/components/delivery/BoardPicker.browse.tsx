import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  getBrowseDirectoryPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
} from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  FilesystemBrowseResult,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { CornerLeftUpIcon, FolderIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";

import { normalizeProjectPathForComparison } from "../../lib/projectPaths";
import { useEnvironment } from "../../state/environments";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { buildBrowseGroups, ITEM_ICON_CLASS } from "../CommandPalette.logic";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { projectRepositoryName } from "./BoardPicker.repositories";

const NO_KEYBINDINGS: ResolvedKeybindingsConfig = [];

/** Same mapping as the Command Palette's, which keeps its own private. */
export function environmentBrowsePlatform(os: string | null | undefined): string {
  if (os === "windows") return "Win32";
  if (os === "darwin") return "MacIntel";
  if (os === "linux") return "Linux";
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

/** Where browsing starts: the environment's add-project folder, else home. */
export function initialBrowseQuery(baseDirectory: string | null | undefined): string {
  const base = baseDirectory?.trim() ?? "";
  return base.length === 0 ? "~/" : ensureBrowseDirectoryPath(base);
}

export type BrowseResolution =
  | { readonly path: string; readonly why: null }
  | { readonly path: null; readonly why: string };

/**
 * The folder a typed path stands for, as the server resolved it, or why there is none. `data`
 * must be the reply to this query's own browse request; the typed text is never the answer.
 */
export function resolveBrowseFolder(input: {
  readonly query: string;
  readonly platform: string;
  readonly connected: boolean;
  /** A picked folder or Up is still loading, so the typed path is about to change. */
  readonly moving: boolean;
  readonly data: FilesystemBrowseResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
}): BrowseResolution {
  const query = input.query.trim();
  if (query.length === 0) return { path: null, why: "Choose a folder." };
  const browse = getFilesystemBrowsePath(input.query, input.platform);
  if (!browse.isBrowsing || isExplicitRelativeProjectPath(query)) {
    return { path: null, why: "Use an absolute or ~/ path." };
  }
  if (!input.connected) return { path: null, why: "Not connected." };
  if (input.moving) return { path: null, why: "Opening folder…" };
  if (input.error) return { path: null, why: input.error };
  if (input.isPending || !input.data) return { path: null, why: "Reading…" };
  if (hasTrailingPathSeparator(input.query)) return { path: input.data.parentPath, why: null };
  const { exactEntry } = filterFilesystemBrowseEntries(input.data.entries, browse.filterQuery);
  return exactEntry
    ? { path: exactEntry.fullPath, why: null }
    : { path: null, why: "Choose a folder." };
}

/** A folder's name: its T3 project's repository name when it is one here, else its own. */
export function suggestedRepositoryName(
  path: string,
  projects: ReadonlyArray<EnvironmentProject>,
  environmentId: EnvironmentId,
): string {
  const wanted = normalizeProjectPathForComparison(path);
  const project = projects.find(
    (item) =>
      item.environmentId === environmentId &&
      normalizeProjectPathForComparison(item.workspaceRoot) === wanted,
  );
  return project ? projectRepositoryName(project) : inferProjectTitleFromPath(path);
}

/**
 * Adding a repository by browsing the board environment's folders, with the Command Palette's
 * add-project browse: rows move into a folder, and only the Add button registers one.
 */
export function RepositoryBrowse(props: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly registering: boolean;
  readonly problem: string | null;
  readonly onCancel: () => void;
  readonly onAdd: (path: string, title: string) => void;
}) {
  const environment = useEnvironment(props.environmentId);
  const platform = environmentBrowsePlatform(environment?.serverConfig?.environment.platform.os);
  const connected = canPreloadBrowsePath(environment?.connection.phase);
  const [query, setQuery] = useState(() =>
    initialBrowseQuery(environment?.serverConfig?.settings.addProjectBaseDirectory),
  );
  const [generation, setGeneration] = useState(0);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  // The name as edited, for the folder it was edited for; another folder gets its own suggestion.
  const [edit, setEdit] = useState<{ readonly path: string; readonly name: string } | null>(null);
  const [navigation] = useState(createBrowseNavigationCoordinator);
  useEffect(() => () => navigation.invalidate(), [navigation]);
  // Only the move that lands clears `moving`; typing abandons every move still loading.
  const [moving, setMoving] = useState(false);
  const stopMoving = () => {
    navigation.invalidate();
    setMoving(false);
  };

  const browsePath = getFilesystemBrowsePath(query, platform);
  // A relative path needs a project to be relative to, and the board has none.
  const relative = isExplicitRelativeProjectPath(query.trim());
  const browseQuery = useEnvironmentQuery(
    browsePath.isBrowsing && browsePath.directoryPath.length > 0 && !relative
      ? filesystemEnvironment.browse({
          environmentId: props.environmentId,
          input: { partialPath: browsePath.directoryPath },
        })
      : null,
  );
  const loadBrowsePath = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
  });
  const { visibleEntries } = filterFilesystemBrowseEntries(
    browseQuery.data?.entries ?? [],
    browsePath.filterQuery,
  );
  const resolution = resolveBrowseFolder({
    query,
    platform,
    connected,
    moving,
    data: browseQuery.data,
    error: browseQuery.error,
    isPending: browseQuery.isPending,
  });
  const suggestion = resolution.path
    ? suggestedRepositoryName(resolution.path, props.projects, props.environmentId)
    : "";
  // Another folder drops the edit, so coming back to the edited one shows its suggestion again.
  if (edit && resolution.path && edit.path !== resolution.path) setEdit(null);
  const name = edit && edit.path === resolution.path ? edit.name : suggestion;

  /** Moves to a folder once its listing is loaded; a later move or typing wins over it. */
  const navigate = async (nextQuery: string) => {
    setMoving(true);
    await navigation.run(
      async () => {
        if (!connected) return;
        await loadBrowsePath({
          environmentId: props.environmentId,
          input: { partialPath: getBrowseDirectoryPath(nextQuery) },
        }).catch(() => undefined);
      },
      () => {
        setHighlighted(null);
        setQuery(nextQuery);
        setGeneration((current) => current + 1);
        setMoving(false);
      },
    );
  };
  // buildBrowseGroups always returns its group, so an empty one is dropped here.
  const groups = relative
    ? []
    : buildBrowseGroups({
        browseEntries: visibleEntries,
        browseQuery: query,
        canBrowseUp: browsePath.canBrowseUp,
        upIcon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
        directoryIcon: <FolderIcon className={ITEM_ICON_CLASS} />,
        browseUp: async () => {
          if (browsePath.parentPath !== null) await navigate(browsePath.parentPath);
        },
        browseTo: async (entryName) => {
          await navigate(appendBrowsePathSegment(query, entryName));
        },
      }).filter((group) => group.items.length > 0);
  // Shown under the rows, so it still shows when only Up is left.
  const listStatus =
    relative || !browsePath.isBrowsing
      ? "Use an absolute or ~/ path."
      : browseQuery.error
        ? browseQuery.error
        : !connected
          ? "Not connected."
          : visibleEntries.length > 0
            ? null
            : browseQuery.isPending
              ? "Reading folders…"
              : "No folders here.";
  const blocked = props.registering
    ? "Adding…"
    : (resolution.why ?? (name.trim() ? null : "Name is empty."));

  const add = () => {
    if (props.registering || moving || !resolution.path || !name.trim()) return;
    props.onAdd(resolution.path, name.trim());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // Cancels the add only: the board dialog around it stays open.
      event.preventDefault();
      event.stopPropagation();
      stopMoving();
      props.onCancel();
      return;
    }
    // Enter moves into the highlighted folder; with none it does nothing, and Add registers.
    if (event.key === "Enter" && !highlighted) event.preventDefault();
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-2">
      <CommandPaletteContent
        key={generation}
        aria-label="Folder of the repository"
        autoHighlight={false}
        escapeLabel="Cancel"
        footerActionLabel="Open folder"
        inputProps={{
          "aria-label": "Folder of the repository",
          placeholder: "~/",
          startAddon: <FolderIcon />,
          onKeyDown,
        }}
        mode="none"
        onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
        onValueChange={(next) => {
          stopMoving();
          setHighlighted(null);
          setQuery(next);
        }}
        panelSize="list"
        value={query}
      >
        {groups.length > 0 ? (
          <CommandPaletteResults
            groups={groups}
            highlightedItemValue={highlighted}
            isActionsOnly={false}
            keybindings={NO_KEYBINDINGS}
            onExecuteItem={(item) => {
              if (item.kind === "action") void item.run();
            }}
          />
        ) : null}
        {listStatus ? (
          <p
            className="py-6 text-center text-sm text-muted-foreground"
            data-board-dialog-browse-status
          >
            {listStatus}
          </p>
        ) : null}
      </CommandPaletteContent>
      <Tooltip>
        <TooltipTrigger
          render={
            <p className="truncate text-xs text-muted-foreground" data-board-dialog-folder-path />
          }
        >
          Folder: {resolution.path ?? "none chosen"}
        </TooltipTrigger>
        {resolution.path ? <TooltipPopup>{resolution.path}</TooltipPopup> : null}
      </Tooltip>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">Name</span>
        <Input
          aria-label="Name of the repository"
          value={name}
          disabled={!resolution.path}
          onChange={(event) =>
            resolution.path ? setEdit({ path: resolution.path, name: event.target.value }) : null
          }
          data-board-dialog-repository-name
        />
      </label>
      <span className="text-2xs text-muted-foreground">
        The folder is read, not changed. Work is done in worktrees made beside it.
      </span>
      <p role="alert" aria-live="polite" className="text-xs text-warning empty:hidden">
        {props.problem}
      </p>
      <span className="flex items-center justify-end gap-2">
        {blocked ? (
          <span className="text-2xs text-muted-foreground" data-board-dialog-add-why>
            {blocked}
          </span>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            stopMoving();
            props.onCancel();
          }}
          data-board-dialog-add-cancel
        >
          Cancel
        </Button>
        <Button
          size="xs"
          disabled={blocked !== null}
          onClick={add}
          data-board-dialog-add-repository
        >
          Add repository
        </Button>
      </span>
    </div>
  );
}
