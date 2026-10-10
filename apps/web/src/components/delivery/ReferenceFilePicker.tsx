import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import type { EnvironmentId, FilesystemBrowseEntry } from "@t3tools/contracts";
import { CornerLeftUpIcon, FolderIcon } from "lucide-react";
import { type KeyboardEvent, useMemo, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { joinReferencePath } from "../../lib/deliveryReferences";
import { ensureBrowseDirectoryPath } from "../../lib/projectPaths";
import { useProjects } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import {
  buildBrowseGroups,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
  ITEM_ICON_CLASS,
} from "../CommandPalette.logic";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { HighlightedFuzzyText } from "../files/ProjectFilePicker";
import {
  getProjectFilePickerMatches,
  PROJECT_FILE_PICKER_RESULT_LIMIT,
} from "../files/ProjectFilePicker.logic";
import { useProjectEntriesQuery, useProjectFilePickerQuery } from "../files/projectFilesQueryState";
import { ProjectFavicon } from "../ProjectFavicon";
import { CommandDialog, CommandDialogPopup } from "../ui/command";

type Step =
  | { readonly kind: "projects" }
  | { readonly kind: "files"; readonly project: EnvironmentProject }
  | { readonly kind: "browse" };

/** As the Command Palette maps an environment's OS for its folder browse. */
function browsePlatform(os: string | null | undefined): string {
  if (os === "windows") return "Win32";
  if (os === "darwin") return "MacIntel";
  if (os === "linux") return "Linux";
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

function runItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem) {
  if (item.kind === "action" && !item.disabled) void item.run();
}

function note(value: string, title: string): CommandPaletteActionItem {
  return {
    kind: "action",
    value,
    searchTerms: [],
    title,
    icon: null,
    disabled: true,
    run: async () => {},
  };
}

/**
 * Picks a reference file on the engine's environment: from one of its
 * projects, searched as the file picker searches, or from a folder reached by
 * the Command Palette's folder browse. `onPick` gets the file's full path.
 */
export function ReferenceFilePicker(props: {
  readonly environmentId: EnvironmentId;
  readonly route: "project" | "browse";
  readonly onPick: (path: string) => void;
  readonly onClose: () => void;
}) {
  const [step, setStep] = useState<Step>(
    props.route === "browse" ? { kind: "browse" } : { kind: "projects" },
  );
  const pick = (path: string) => {
    props.onClose();
    props.onPick(path);
  };
  return (
    <CommandDialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <CommandDialogPopup
        aria-label="Add a reference file"
        className="overflow-hidden p-0"
        onBackdropPointerDown={props.onClose}
      >
        {step.kind === "projects" ? (
          <ProjectStep
            environmentId={props.environmentId}
            onChoose={(project) => setStep({ kind: "files", project })}
          />
        ) : step.kind === "files" ? (
          <ProjectFilesStep
            environmentId={props.environmentId}
            project={step.project}
            onBack={() => setStep({ kind: "projects" })}
            onPick={pick}
          />
        ) : (
          <BrowseStep environmentId={props.environmentId} onPick={pick} />
        )}
      </CommandDialogPopup>
    </CommandDialog>
  );
}

function ProjectStep(props: {
  readonly environmentId: EnvironmentId;
  readonly onChoose: (project: EnvironmentProject) => void;
}) {
  const projects = useProjects();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const items = useMemo<CommandPaletteActionItem[]>(() => {
    const needle = query.trim().toLowerCase();
    return projects
      .filter((project) => project.environmentId === props.environmentId)
      .filter(
        (project) =>
          project.title.toLowerCase().includes(needle) ||
          project.workspaceRoot.toLowerCase().includes(needle),
      )
      .map((project) => ({
        kind: "action",
        value: `project:${project.id}`,
        searchTerms: [project.title, project.workspaceRoot],
        title: project.title,
        description: project.workspaceRoot,
        icon: <ProjectFavicon project={project} className="size-4" />,
        keepOpen: true,
        run: async () => props.onChoose(project),
      }));
  }, [projects, props, query]);
  return (
    <CommandPaletteContent
      aria-label="Choose a project"
      autoHighlight="always"
      escapeLabel="Close"
      footerActionLabel="Search its files"
      inputProps={{ placeholder: "Search projects…" }}
      mode="none"
      onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
      onValueChange={(value) => {
        setHighlighted(null);
        setQuery(value);
      }}
      panelClassName="max-h-[min(34rem,76vh)]"
      testId="reference-project-picker"
      value={query}
    >
      <CommandPaletteResults
        groups={items.length > 0 ? [{ value: "projects", label: "Projects", items }] : []}
        highlightedItemValue={highlighted}
        isActionsOnly={false}
        keybindings={keybindings}
        onExecuteItem={runItem}
        emptyStateMessage={
          query.trim() ? "No matching projects." : "This environment has no projects."
        }
      />
    </CommandPaletteContent>
  );
}

function filesEmptyMessage(query: string, error: string | null, isPending: boolean): string {
  if (error) return error;
  const isSearching = query.trim().length > 0;
  if (isPending) return isSearching ? "Searching workspace files…" : "Indexing workspace files…";
  return isSearching ? "No matching files." : "No files found.";
}

function ProjectFilesStep(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly onBack: () => void;
  readonly onPick: (path: string) => void;
}) {
  const { project } = props;
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const result = useProjectFilePickerQuery(
    props.environmentId,
    project.workspaceRoot,
    query,
    PROJECT_FILE_PICKER_RESULT_LIMIT,
  );
  const { resolvedTheme } = useTheme();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hasMatchedQuery = /\S/.test(result.matchedQuery);
  const items = useMemo<CommandPaletteActionItem[]>(
    () =>
      getProjectFilePickerMatches(result.entries, result.matchedQuery).map((match) => ({
        kind: "action",
        value: `file:${match.path}`,
        searchTerms: [match.name, match.path],
        title: (
          <HighlightedFuzzyText
            active={hasMatchedQuery}
            value={match.name}
            indices={match.nameMatchIndices}
          />
        ),
        description: (
          <HighlightedFuzzyText
            active={hasMatchedQuery}
            value={match.path}
            indices={match.pathMatchIndices}
          />
        ),
        icon: <PierreEntryIcon pathValue={match.path} kind="file" theme={resolvedTheme} />,
        run: async () => props.onPick(joinReferencePath(project.workspaceRoot, match.path)),
      })),
    [hasMatchedQuery, project.workspaceRoot, props, resolvedTheme, result],
  );
  // Escape, or Backspace in an empty search, goes back to the projects.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape" && !(event.key === "Backspace" && query === "")) return;
    event.preventDefault();
    event.stopPropagation();
    props.onBack();
  };
  return (
    <CommandPaletteContent
      aria-label="Choose a file of the project"
      autoHighlight="always"
      escapeLabel="Back"
      footerActionLabel="Add reference"
      inputProps={{ placeholder: `Search files of ${project.title}…`, onKeyDown }}
      mode="none"
      onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
      onValueChange={(value) => {
        setHighlighted(null);
        setQuery(value);
      }}
      panelClassName="max-h-[min(34rem,76vh)]"
      showBackHint
      testId="reference-file-picker"
      value={query}
    >
      <CommandPaletteResults
        groups={items.length > 0 ? [{ value: "project-files", label: project.title, items }] : []}
        highlightedItemValue={highlighted}
        isActionsOnly={false}
        keybindings={keybindings}
        onExecuteItem={runItem}
        emptyStateMessage={filesEmptyMessage(query, result.error, result.isPending)}
      />
    </CommandPaletteContent>
  );
}

/**
 * Folders come from the environment's folder browse, which lists folders
 * only; the files of the folder reached come from its immediate listing. The
 * search box filters names, it never takes a path.
 */
function BrowseStep(props: {
  readonly environmentId: EnvironmentId;
  readonly onPick: (path: string) => void;
}) {
  const config = useEnvironment(props.environmentId)?.serverConfig ?? null;
  const platform = browsePlatform(config?.environment.platform.os);
  const start =
    ensureBrowseDirectoryPath(config?.settings.addProjectBaseDirectory?.trim() ?? "") || "~/";
  const [folder, setFolder] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const browsePath = getFilesystemBrowsePath(folder ?? start, platform);
  const browse = useEnvironmentQuery(
    browsePath.isBrowsing
      ? filesystemEnvironment.browse({
          environmentId: props.environmentId,
          input: { partialPath: browsePath.directoryPath },
        })
      : null,
  );
  const listed = browse.data;
  const go = (path: string) => {
    setFolder(ensureBrowseDirectoryPath(path));
    setQuery("");
    setHighlighted(null);
  };
  const message = !browsePath.isBrowsing
    ? "This folder cannot be browsed on this environment."
    : browse.error
      ? browse.error
      : browse.isPending || !listed
        ? "Reading the folder…"
        : null;
  return (
    <CommandPaletteContent
      aria-label="Browse folders"
      autoHighlight="always"
      escapeLabel="Close"
      footerActionLabel="Open folder or add file"
      inputProps={{
        placeholder: listed ? `Filter ${listed.parentPath}` : "Filter names…",
      }}
      mode="none"
      onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
      onValueChange={(value) => {
        setHighlighted(null);
        setQuery(value);
      }}
      panelClassName="max-h-[min(34rem,76vh)]"
      testId="reference-browse-picker"
      value={query}
    >
      {message !== null || !listed ? (
        <CommandPaletteResults
          groups={[]}
          isActionsOnly={false}
          keybindings={keybindings}
          onExecuteItem={runItem}
          emptyStateMessage={message ?? ""}
        />
      ) : (
        <BrowsedFolder
          key={listed.parentPath}
          environmentId={props.environmentId}
          folder={listed.parentPath}
          folders={listed.entries}
          platform={platform}
          query={query}
          highlighted={highlighted}
          onGo={go}
          onPick={props.onPick}
        />
      )}
    </CommandPaletteContent>
  );
}

function BrowsedFolder(props: {
  readonly environmentId: EnvironmentId;
  /** The folder as the server resolved it. */
  readonly folder: string;
  readonly folders: ReadonlyArray<FilesystemBrowseEntry>;
  readonly platform: string;
  readonly query: string;
  readonly highlighted: string | null;
  readonly onGo: (path: string) => void;
  readonly onPick: (path: string) => void;
}) {
  const { folder } = props;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { resolvedTheme } = useTheme();
  // An empty directory path lists the folder's immediate children, ignored ones included.
  const listing = useProjectEntriesQuery(props.environmentId, folder, "");
  const up = getFilesystemBrowsePath(ensureBrowseDirectoryPath(folder), props.platform);
  const groups = useMemo<CommandPaletteGroup[]>(() => {
    const folders = filterFilesystemBrowseEntries(props.folders, props.query).visibleEntries;
    const [directories] = buildBrowseGroups({
      browseEntries: folders,
      browseQuery: props.query,
      canBrowseUp: up.canBrowseUp,
      upIcon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
      directoryIcon: <FolderIcon className={ITEM_ICON_CLASS} />,
      browseUp: () => (up.parentPath ? props.onGo(up.parentPath) : undefined),
      browseTo: (name) => {
        const entry = folders.find((item) => item.name === name);
        if (entry) props.onGo(entry.fullPath);
      },
    });
    const files = filterFilesystemBrowseEntries(
      (listing.data?.entries ?? [])
        .filter((entry) => entry.kind === "file")
        .map((entry) => ({ name: entry.path, fullPath: joinReferencePath(folder, entry.path) })),
      props.query,
    ).visibleEntries;
    const fileItems: CommandPaletteActionItem[] = files.map((file) => ({
      kind: "action",
      value: `reference:${file.fullPath}`,
      searchTerms: [file.name, file.fullPath],
      title: file.name,
      icon: <PierreEntryIcon pathValue={file.name} kind="file" theme={resolvedTheme} />,
      run: async () => props.onPick(file.fullPath),
    }));
    if (listing.error) fileItems.push(note("browse:files-error", listing.error));
    else if (listing.isPending) fileItems.push(note("browse:files-pending", "Reading files…"));
    else if (listing.data?.truncated)
      fileItems.push(note("browse:files-truncated", "Not every file is shown. Filter to narrow."));
    const all: CommandPaletteGroup[] = [];
    if (directories && directories.items.length > 0) all.push(directories);
    if (fileItems.length > 0) all.push({ value: "files", label: folder, items: fileItems });
    return all;
  }, [folder, listing, props, resolvedTheme, up.canBrowseUp, up.parentPath]);
  return (
    <CommandPaletteResults
      groups={groups}
      highlightedItemValue={props.highlighted}
      isActionsOnly={false}
      keybindings={keybindings}
      onExecuteItem={runItem}
      emptyStateMessage={
        props.query ? "No matching folders or files." : "No folders or files here."
      }
    />
  );
}
