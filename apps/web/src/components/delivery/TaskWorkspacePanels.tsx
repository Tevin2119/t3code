import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
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

const isTaskTab = (surface: RightPanelSurface) =>
  surface.kind === "task-evidence" || surface.kind === "task-deployments";

/** Opens a task's own panel at its tabs: a first open, or one after every tab was closed, adds both. */
function openTaskTabs(ref: ScopedThreadRef) {
  const store = useRightPanelStore.getState();
  if (selectThreadRightPanelState(store.byThreadKey, ref).surfaces.some(isTaskTab)) {
    store.show(ref);
    return;
  }
  store.open(ref, "task-evidence");
  store.open(ref, "task-deployments");
  store.activateSurface(ref, "task-evidence");
}

/**
 * Task-owned panels share native sizing and sheet behavior without inventing a thread owner. A
 * task with a thread keeps its tabs on that thread's right panel, behind the thread view's own
 * toggles. One without (a draft, a queued, unlinked or moved task) gets a panel owned by
 * `taskPanelRef` behind the native right panel toggle under its header. The task's facts are in the
 * board's left column either way. Nothing opens unasked.
 */
export function TaskWorkspacePanels(props: {
  owner: string;
  /** The task's own thread, whose right panel holds the task's tabs. */
  thread: ScopedThreadRef | null;
  renderConversation: (panel: {
    /** The native panel toggle for a page; none with a thread, whose view has its own. */
    readonly controls: ReactNode;
  }) => ReactNode;
  evidence: ReactNode;
  /** The deployments tab: delivering the task and its deployments. */
  deployments: ReactNode;
}) {
  const sheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const panelRef = props.thread ?? taskPanelRef(props.owner);
  const panel = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, panelRef),
  );
  const ownPanel = props.thread === null;
  const evidenceOpen = ownPanel && panel.isOpen;
  const maximized = evidenceOpen && panel.maximized === true;
  const closeEvidence = () => {
    useRightPanelStore.getState().close(panelRef);
    useRightPanelStore.getState().setMaximized(panelRef, false);
  };
  const setMaximized = (next: boolean) =>
    useRightPanelStore.getState().setMaximized(panelRef, next);
  const controls = ownPanel ? (
    <PanelLayoutControls
      showTerminalControl={false}
      terminalAvailable={false}
      terminalOpen={false}
      terminalShortcutLabel={null}
      onToggleTerminal={NOTHING}
      showThreadPanelControl={false}
      threadPanelOpen={false}
      threadPanelPresentation="popover"
      threadPanelShortcutLabel={null}
      onToggleThreadPanel={NOTHING}
      rightPanelAvailable
      rightPanelOpen={evidenceOpen}
      rightPanelShortcutLabel={null}
      onToggleRightPanel={() => (evidenceOpen ? closeEvidence() : openTaskTabs(panelRef))}
    />
  ) : null;
  const panelMode = sheet ? "sheet" : "inline";
  const activeSurface =
    panel.surfaces.find((surface) => surface.id === panel.activeSurfaceId) ?? null;
  const store = () => useRightPanelStore.getState();
  const evidence = ownPanel ? (
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
              shortcutLabel={null}
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
      onCloseSelectedSurfaces={(surfaces) =>
        store().closeSurfaces(
          panelRef,
          surfaces.map((surface) => surface.id),
        )
      }
      onCloseOtherSurfaces={(surface) => store().closeOtherSurfaces(panelRef, surface.id)}
      onCloseSurfacesToRight={(surface) => store().closeSurfacesToRight(panelRef, surface.id)}
      onCloseAllSurfaces={() => store().closeAllSurfaces(panelRef)}
      onMoveSurfaces={(surfaceIds, targetId) =>
        store().moveSurfaces(panelRef, surfaceIds, targetId)
      }
      onCopyFilePath={NOTHING}
      onAddBrowser={NOTHING}
      onAddBrowserInProfile={NOTHING}
      onAddTerminal={NOTHING}
      onAddDiff={NOTHING}
      onAddFiles={NOTHING}
      onAddPullRequest={NOTHING}
      onAddPullRequests={NOTHING}
      onAddDevice={NOTHING}
      onAddTaskSurface={(kind) => store().open(panelRef, kind)}
      browserAvailable={false}
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
    >
      <div className="flex min-h-0 flex-1">
        {activeSurface?.kind === "task-deployments" ? props.deployments : props.evidence}
      </div>
    </RightPanelTabs>
  ) : null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-task-workspace-panels>
      <div className={maximized && !sheet ? "hidden" : "flex min-h-0 min-w-0 flex-1"}>
        {props.renderConversation({ controls })}
      </div>
      {sheet ? (
        <RightPanelSheet animationDurationMs={0} open={evidenceOpen} onClose={closeEvidence}>
          {evidence}
        </RightPanelSheet>
      ) : (
        evidence
      )}
    </div>
  );
}
