import { workspaceAreaProps } from "../../lib/workspaceFocus";
import type { ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useLayoutEffect, useState } from "react";
import * as Schema from "effect/Schema";
import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import {
  selectThreadRightPanelState,
  taskPanelRef,
  useRightPanelStore,
  type RightPanelSurface,
} from "../../rightPanelStore";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { PanelLayoutControls, RightPanelMaximizeControl } from "../chat/PanelLayoutControls";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelTabs } from "../RightPanelTabs";
import { Button } from "../ui/button";

const NO_SURFACES = new Set<string>();
/** Below this width the task's badges leave the header for a row of their own under it. */
const BADGES_IN_HEADER_MIN_WIDTH = 760;
const NO_PREVIEW_SESSIONS = {};
const NO_PREVIEW_DESKTOP_STATE = {};
const NO_TERMINAL_LABELS = new Map<string, string>();
const NOTHING = () => undefined;

function getShortcutContext() {
  return {
    terminalFocus: false,
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    isWeb: !isElectron,
    isDesktop: isElectron,
  };
}

/** Opens a task's panel. A first open, or one after every tab was closed, brings both tabs back. */
function openTaskPanel(owner: string, surface?: "task-evidence" | "task-deployments") {
  const ref = taskPanelRef(owner);
  const store = useRightPanelStore.getState();
  if (selectThreadRightPanelState(store.byThreadKey, ref).surfaces.length === 0) {
    store.open(ref, "task-evidence");
    store.open(ref, "task-deployments");
    store.activateSurface(ref, surface ?? "task-evidence");
    return;
  }
  if (surface) store.open(ref, surface);
  else store.show(ref);
}

/**
 * Task-owned panels share native sizing and sheet behavior without inventing a thread owner. The
 * right panel is T3's own tab panel, owned by `taskPanelRef`, so a thread view never shows it.
 * A thread view keeps the task's details in its own details panel; where none stands, they open
 * as a sheet. The toggles are handed to the centre, which puts them under the native header,
 * clear of the window's own panel toggles.
 */
export function TaskWorkspacePanels(props: {
  owner: string;
  /** Open the right panel the first time this task is shown. */
  openFirst?: boolean;
  /** The sheet's content: the task's details where no thread view hosts them. */
  details: ReactNode;
  renderConversation: (panel: {
    /** Both toggles, for a page whose details are the sheet. */
    readonly controls: ReactNode;
    /** The right panel toggle alone, beside a thread view whose details are its own. */
    readonly rightPanelControl: ReactNode;
    readonly showDetails: () => void;
    readonly openTab: (tab: "task-evidence" | "task-deployments") => void;
    /** The centre is too narrow for the task's badges in its header. */
    readonly narrow: boolean;
  }) => ReactNode;
  evidence: ReactNode;
  /** The deployments tab: the task's deployment status, one row per environment. */
  deployments: ReactNode;
  detailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
}) {
  const sheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const [centre, setCentre] = useState<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the centre's laid-out width, which only the DOM knows, so the badges sit where they fit before the first paint
  useLayoutEffect(() => {
    if (!centre) return;
    const measure = () => setNarrow(centre.clientWidth < BADGES_IN_HEADER_MIN_WIDTH);
    measure();
    return observeResize(centre, measure);
  }, [centre]);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const panelRef = taskPanelRef(props.owner);
  const panel = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, panelRef),
  );
  const evidenceOpen = panel.isOpen;
  // A task never opened before shows its engine facts beside the conversation when the width holds
  // conversation and panel together. That it happened is kept apart from the tabs: closing every
  // tab empties them, and the panel must stay closed all the same.
  const roomy = useMediaQuery("(min-width: 1360px)");
  const [firstOpenDone, setFirstOpenDone] = useLocalStorage(
    `t3code:task-panel-first-open:${props.owner}`,
    false,
    Schema.Boolean,
  );
  const hasTabs = panel.surfaces.length > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the task's right panel in the external panel store on a first visit, and records in local storage that the task has had its panel
  useEffect(() => {
    if (firstOpenDone) return;
    if (hasTabs) setFirstOpenDone(true);
    else if (props.openFirst && roomy && !sheet) openTaskPanel(props.owner);
  }, [props.openFirst, firstOpenDone, hasTabs, roomy, sheet, props.owner, setFirstOpenDone]);
  const maximized = panel.isOpen && panel.maximized === true;
  const closeEvidence = () => {
    useRightPanelStore.getState().close(panelRef);
    useRightPanelStore.getState().setMaximized(panelRef, false);
  };
  const openEvidence = () => openTaskPanel(props.owner);
  const setMaximized = (next: boolean) =>
    useRightPanelStore.getState().setMaximized(panelRef, next);
  const toggles = (withDetails: boolean) => (
    <PanelLayoutControls
      showThreadPanelControl={withDetails}
      detailsLabel="Toggle task details panel"
      showTerminalControl={false}
      terminalAvailable={false}
      terminalOpen={false}
      terminalShortcutLabel={null}
      onToggleTerminal={() => {}}
      threadPanelOpen={props.detailsOpen && !(sheet && evidenceOpen)}
      threadPanelPresentation="inline"
      threadPanelShortcutLabel={null}
      onToggleThreadPanel={() => {
        if (sheet && evidenceOpen) {
          closeEvidence();
          props.onDetailsOpenChange(true);
        } else props.onDetailsOpenChange(!props.detailsOpen);
      }}
      rightPanelAvailable
      rightPanelOpen={evidenceOpen}
      rightPanelShortcutLabel={null}
      onToggleRightPanel={() => {
        if (evidenceOpen) closeEvidence();
        else {
          if (sheet) props.onDetailsOpenChange(false);
          openEvidence();
        }
      }}
    />
  );
  const panelMode = sheet ? "sheet" : "inline";
  const activeSurface =
    panel.surfaces.find((surface) => surface.id === panel.activeSurfaceId) ?? null;
  const store = () => useRightPanelStore.getState();
  const evidence = (
    <RightPanelTabs
      mode={panelMode}
      open={evidenceOpen}
      maximized={maximized}
      keybindings={keybindings}
      getShortcutContext={getShortcutContext}
      // One key per task keeps each task's remembered panel width independent.
      widthStorageKey={`t3code:task-evidence-width:${props.owner}`}
      defaultWidth={400}
      layoutControls={
        // Inline, the panel's top right sits under the window's own panel toggles.
        <span className={cn("flex shrink-0 items-center gap-1", panelMode === "inline" && "pe-28")}>
          {panelMode === "inline" ? (
            <RightPanelMaximizeControl
              maximized={maximized}
              onToggle={() => setMaximized(!maximized)}
            />
          ) : null}
          <Button size="xs" variant="ghost" onClick={closeEvidence}>
            Close evidence
          </Button>
        </span>
      }
      surfaces={panel.surfaces}
      environmentId={null}
      activeSurfaceId={activeSurface?.id ?? null}
      pendingSurfaceIds={NO_SURFACES}
      previewSessions={NO_PREVIEW_SESSIONS}
      desktopByTabId={NO_PREVIEW_DESKTOP_STATE}
      terminalLabelsById={NO_TERMINAL_LABELS}
      onActivate={(surface: RightPanelSurface) => store().activateSurface(panelRef, surface.id)}
      onCloseSurface={(surface) => store().closeSurface(panelRef, surface.id)}
      onCloseOtherSurfaces={(surface) => store().closeOtherSurfaces(panelRef, surface.id)}
      onCloseSurfacesToRight={(surface) => store().closeSurfacesToRight(panelRef, surface.id)}
      onCloseAllSurfaces={() => store().closeAllSurfaces(panelRef)}
      onMoveSurface={(surfaceId, toIndex) => store().moveSurface(panelRef, surfaceId, toIndex)}
      onCopyFilePath={NOTHING}
      onAddBrowser={NOTHING}
      onAddBrowserInProfile={NOTHING}
      onAddTerminal={NOTHING}
      onAddDiff={NOTHING}
      onAddFiles={NOTHING}
      onAddPullRequest={NOTHING}
      onAddPullRequests={NOTHING}
      onAddDevice={NOTHING}
      browserAvailable={false}
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
    >
      <div className="flex min-h-0 flex-1 overflow-y-auto">
        {activeSurface?.kind === "task-deployments" ? props.deployments : props.evidence}
      </div>
    </RightPanelTabs>
  );
  const detailsShown = props.detailsOpen && !(sheet && evidenceOpen);
  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-task-workspace-panels>
      <div
        ref={setCentre}
        className={maximized && !sheet && evidenceOpen ? "hidden" : "flex min-h-0 min-w-0 flex-1"}
      >
        {props.renderConversation({
          controls: toggles(true),
          rightPanelControl: toggles(false),
          showDetails: () => {
            closeEvidence();
            props.onDetailsOpenChange(true);
          },
          openTab: (tab) => {
            if (sheet) props.onDetailsOpenChange(false);
            openTaskPanel(props.owner, tab);
          },
          narrow,
        })}
      </div>
      {sheet ? (
        <RightPanelSheet animationDurationMs={0} open={evidenceOpen} onClose={closeEvidence}>
          {evidence}
        </RightPanelSheet>
      ) : (
        evidence
      )}
      <RightPanelSheet
        animationDurationMs={0}
        open={detailsShown}
        onClose={() => props.onDetailsOpenChange(false)}
      >
        <div className="flex h-full min-h-0 flex-col">
          <header className="flex justify-end border-b p-2">
            <Button size="xs" variant="ghost" onClick={() => props.onDetailsOpenChange(false)}>
              Close task details
            </Button>
          </header>
          <div
            {...workspaceAreaProps("task-navigation", 1, "Task team and details")}
            data-workspace-focus-key={`task-navigation:${props.owner}`}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
            data-task-details-sheet
          >
            {/* Mounted only while open, so the thread view's own details are the only copy. */}
            {detailsShown ? props.details : null}
          </div>
        </div>
      </RightPanelSheet>
    </div>
  );
}
