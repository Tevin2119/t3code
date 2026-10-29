import { normalizeProjectPathForComparison } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { FolderIcon, FolderPlusIcon } from "lucide-react";
import { type Ref, useState } from "react";

import {
  buildProjectActionItems,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
  filterCommandPaletteGroups,
  ITEM_ICON_CLASS,
} from "../CommandPalette.logic";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { ProjectFavicon } from "../ProjectFavicon";
import { CommandDialog, CommandDialogPopup } from "../ui/command";
import { SelectButton } from "../ui/select";
import type { RepositoryChoice } from "./BoardPicker.repositories";

/** The value `onChoose` gets for the "Add a repository by its folder" row. */
export const ADD_REPOSITORY = "__add_repository__";

const NO_KEYBINDINGS: ResolvedKeybindingsConfig = [];

/**
 * The palette's groups: engine repositories, then T3 projects as the Command Palette lists them,
 * then adding by folder. Engine rows use the icon of the T3 project in their folder.
 */
function repositoryPickerGroups(input: {
  readonly environmentId: EnvironmentId | null;
  readonly choices: ReadonlyArray<RepositoryChoice>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectsLabel: string;
  /** Why T3 projects cannot be added now; their rows stay listed but disabled. */
  readonly projectBlocked?: string | null;
  readonly canAddFolder: boolean;
  readonly onChoose: (value: string) => void;
}): CommandPaletteGroup[] {
  const projectIn = (folder: string) => {
    const wanted = normalizeProjectPathForComparison(folder);
    return input.projects.find(
      (project) =>
        project.environmentId === input.environmentId &&
        normalizeProjectPathForComparison(project.workspaceRoot) === wanted,
    );
  };
  // A folder no T3 project here has, shown as the palette shows a project.
  const folderItem = (row: {
    readonly value: string;
    readonly title: string;
    readonly folder: string;
    readonly problem: string | null;
  }): CommandPaletteActionItem => ({
    kind: "action",
    value: row.value,
    searchTerms: [row.title, row.folder],
    title: row.title,
    description: row.problem ? `${row.folder} · ${row.problem}` : row.folder,
    icon: (() => {
      const project =
        projectIn(row.folder) ??
        (input.environmentId
          ? { environmentId: input.environmentId, workspaceRoot: row.folder, title: row.title }
          : null);
      return project ? (
        <ProjectFavicon project={project} className={ITEM_ICON_CLASS} />
      ) : (
        <FolderIcon className={ITEM_ICON_CLASS} />
      );
    })(),
    disabled: row.problem !== null,
    run: async () => input.onChoose(row.value),
  });
  const blocked = input.projectBlocked ?? null;
  const engine: CommandPaletteActionItem[] = [];
  const projects: CommandPaletteActionItem[] = [];
  for (const choice of input.choices) {
    if (choice.kind === "engine") {
      const { repository } = choice;
      engine.push(
        folderItem({
          value: choice.value,
          title: repository.title,
          folder: repository.path,
          problem: repository.ok ? null : (repository.problem ?? "It cannot be read."),
        }),
      );
      continue;
    }
    const project = projectIn(choice.folder);
    const [item] = project
      ? buildProjectActionItems({
          projects: [{ ...project, displayName: choice.name }],
          valuePrefix: "project",
          icon: (listed) => <ProjectFavicon project={listed} className={ITEM_ICON_CLASS} />,
          runProject: async () => input.onChoose(choice.value),
          ...(blocked ? { renderDescription: () => `${choice.folder} · ${blocked}` } : {}),
        })
      : [
          folderItem({
            value: choice.value,
            title: choice.name,
            folder: choice.folder,
            problem: blocked,
          }),
        ];
    if (item) projects.push({ ...item, value: choice.value, disabled: blocked !== null });
  }
  const add: CommandPaletteActionItem = {
    kind: "action",
    value: ADD_REPOSITORY,
    searchTerms: ["Add a repository by its folder", "folder", "browse"],
    title: "Add a repository by its folder…",
    icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
    run: async () => input.onChoose(ADD_REPOSITORY),
  };
  const groups: CommandPaletteGroup[] = [
    { value: "repositories", label: "Repositories", items: engine },
    { value: "projects", label: input.projectsLabel, items: projects },
    { value: "add", label: "", items: input.canAddFolder ? [add] : [] },
  ];
  return groups.filter((group) => group.items.length > 0);
}

function runItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem) {
  if (item.kind === "action" && !item.disabled) void item.run();
}

/**
 * Picks a repository or T3 project with the Command Palette's project list: a select-style field
 * that opens the palette, searched as the palette searches.
 */
export function RepositoryPicker({
  ref,
  ...props
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly environmentId: EnvironmentId | null;
  /** The chosen row's value, or null. */
  readonly value: string | null;
  /** What the field shows for the chosen row. */
  readonly shown: string | null;
  readonly choices: ReadonlyArray<RepositoryChoice>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectsLabel: string;
  readonly projectBlocked?: string | null;
  readonly canAddFolder: boolean;
  readonly disabled?: boolean;
  readonly onChoose: (value: string) => void;
  readonly ref?: Ref<HTMLButtonElement>;
  readonly marker?: string;
  /** The field's size, matching the other fields of its form. */
  readonly size?: "compact" | "default";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setQuery("");
    setHighlighted(null);
  };
  const groups = filterCommandPaletteGroups({
    activeGroups: repositoryPickerGroups({
      environmentId: props.environmentId,
      choices: props.choices,
      projects: props.projects,
      projectsLabel: props.projectsLabel,
      projectBlocked: props.projectBlocked ?? null,
      canAddFolder: props.canAddFolder,
      onChoose: (value) => {
        close();
        props.onChoose(value);
      },
    }),
    query,
    isInSubmenu: true,
    projectSearchItems: [],
    threadSearchItems: [],
  });
  return (
    <>
      <SelectButton
        ref={ref}
        aria-label={props.label}
        size={props.size ?? "compact"}
        disabled={props.disabled}
        onClick={() => setOpen(true)}
        data-repository-picker={props.marker}
      >
        {props.shown ?? <span className="text-muted-foreground">{props.placeholder}</span>}
      </SelectButton>
      {open ? (
        <CommandDialog open onOpenChange={(next) => (next ? undefined : close())}>
          <CommandDialogPopup aria-label={props.label} onBackdropPointerDown={close}>
            <CommandPaletteContent
              aria-label={props.label}
              autoHighlight="always"
              escapeLabel="Close"
              footerActionLabel="Choose"
              inputProps={{
                placeholder: props.choices.some((choice) => choice.kind === "engine")
                  ? "Search repositories and projects…"
                  : "Search projects…",
              }}
              mode="none"
              onItemHighlighted={(value) =>
                setHighlighted(typeof value === "string" ? value : null)
              }
              onValueChange={(next) => {
                setHighlighted(null);
                setQuery(next);
              }}
              panelSize="tall-list"
              value={query}
            >
              <CommandPaletteResults
                groups={groups}
                highlightedItemValue={highlighted}
                isActionsOnly={false}
                keybindings={NO_KEYBINDINGS}
                onExecuteItem={runItem}
                emptyStateMessage={
                  query.trim()
                    ? "No matching repositories or projects."
                    : "No repositories or projects here."
                }
              />
            </CommandPaletteContent>
          </CommandDialogPopup>
        </CommandDialog>
      ) : null}
    </>
  );
}
