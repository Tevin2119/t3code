import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { FileExplorerPane } from "../files/FileExplorerPane";
import { ThreadInspectionContext } from "../chat/ThreadInspectionContext";
import type { ReactNode } from "react";
import { ScopedThreadRef } from "@t3tools/contracts";
const ChatView = lazy(() => import("../ChatView"));
const ThreadRelationshipsPanel = lazy(() =>
  import("../chat/ThreadRelationshipsControl").then((module) => ({
    default: module.ThreadRelationshipsPanel,
  })),
);
const optionalThreadSchema = Schema.NullOr(ScopedThreadRef);
import { useAtomValue } from "@effect/atom-react";
import { lazy, Suspense } from "react";
import * as Schema from "effect/Schema";
import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
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
 */
export function TaskWorkspacePanels(props: {
  owner: string;
  source?: ScopedThreadRef | null;
  navigation?: ReactNode;
  details: ReactNode;
  conversation?: ReactNode;
  renderConversation?: (showDetails: () => void) => ReactNode;
  evidence: ReactNode;
  /** The deployments tab: the task's deployment status, one row per environment. */
  deployments: ReactNode;
  detailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
}) {
  const sheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const panelRef = taskPanelRef(props.owner);
  const panel = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, panelRef),
  );
  const evidenceOpen = panel.isOpen;
  const maximized = panel.isOpen && panel.maximized === true;
  const [selectedThread, setSelectedThread] = useLocalStorage(
    `t3code:task-inspected-thread:${props.owner}`,
    null as ScopedThreadRef | null,
    optionalThreadSchema,
  );
  const inspectingSource = selectedThread !== null;
  const inspectThread = (thread: ScopedThreadRef) => setSelectedThread(thread);
  const closeEvidence = () => {
    useRightPanelStore.getState().close(panelRef);
    useRightPanelStore.getState().setMaximized(panelRef, false);
  };
  const openEvidence = () => openTaskPanel(props.owner);
  const setMaximized = (next: boolean) =>
    useRightPanelStore.getState().setMaximized(panelRef, next);
  const controls = (
    <PanelLayoutControls
      detailsLabel="Toggle task details panel"
      showTerminalControl={false}
      terminalAvailable={false}
      terminalOpen={false}
      terminalShortcutLabel={null}
      onToggleTerminal={() => {}}
      threadPanelOpen={props.detailsOpen && !maximized && !(sheet && evidenceOpen)}
      threadPanelPresentation="inline"
      threadPanelShortcutLabel={null}
      onToggleThreadPanel={() => {
        if (maximized || (sheet && evidenceOpen)) {
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
  const panelMode = sheet || inspectingSource ? "sheet" : "inline";
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
      widthStorageKey="t3code:task-evidence-width"
      defaultWidth={400}
      layoutControls={
        <span className="flex shrink-0 items-center gap-1">
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
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-task-workspace-panels>
      <header className="flex shrink-0 items-center justify-between border-b px-3 py-1">
        <span className="text-xs text-muted-foreground">Conversation</span>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="ghost"
            disabled={!props.source && !selectedThread}
            title={
              selectedThread
                ? "Return to the task conversation"
                : props.source
                  ? "Inspect the source conversation and its workspace"
                  : "This task has no source conversation. Native thread tools and terminal are unavailable."
            }
            onClick={() => setSelectedThread(inspectingSource ? null : (props.source ?? null))}
          >
            {inspectingSource ? "Back to task conversation" : "Inspect source workspace"}
          </Button>
          {selectedThread &&
          props.source &&
          (selectedThread.threadId !== props.source.threadId ||
            selectedThread.environmentId !== props.source.environmentId) ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setSelectedThread(props.source ?? null)}
            >
              Source conversation
            </Button>
          ) : null}
          {inspectingSource ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => (evidenceOpen ? closeEvidence() : openEvidence())}
            >
              Task evidence and actions
            </Button>
          ) : (
            controls
          )}
        </div>
      </header>
      {selectedThread ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <p className="shrink-0 border-b px-3 py-1 text-xs text-muted-foreground">
            Source conversation workspace. Tools and terminal belong to this conversation and its
            project, not an engine run.
          </p>
          <ThreadInspectionContext value={inspectThread}>
            <Suspense fallback={<p>Loading conversation...</p>}>
              <ChatView
                environmentId={selectedThread.environmentId}
                threadId={selectedThread.threadId}
                routeKind="server"
                unavailableContent={
                  <p role="status" className="p-4 text-sm text-muted-foreground">
                    This conversation is loading or unavailable in its environment. Return to the
                    task to keep reading its history and evidence.
                  </p>
                }
              />
            </Suspense>
          </ThreadInspectionContext>
        </div>
      ) : null}
      <div className={inspectingSource ? "hidden" : "flex min-h-0 min-w-0 flex-1"}>
        {!sheet && props.detailsOpen && !maximized ? (
          <FileExplorerPane
            resizable
            label="Task details"
            resizeLabel="Resize task navigation"
            storageKey="t3code:task-navigation-width"
            defaultWidth={300}
            minWidth={220}
            edge="right"
          >
            <div
              {...workspaceAreaProps("task-navigation", 1, "Task team and details")}
              data-workspace-focus-key={`task-navigation:${props.owner}`}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto"
            >
              {props.navigation ? (
                <div className="shrink-0 border-b p-3">{props.navigation}</div>
              ) : null}
              {props.source ? (
                <ThreadInspectionContext value={inspectThread}>
                  <Suspense fallback={<p className="p-3 text-xs">Loading agent lineage...</p>}>
                    <div className="shrink-0 border-b p-3">
                      <ThreadRelationshipsPanel
                        environmentId={props.source.environmentId}
                        threadId={props.source.threadId}
                        showLineage
                        showSideChats
                      />
                    </div>
                  </Suspense>
                </ThreadInspectionContext>
              ) : null}
              {props.details}
            </div>
          </FileExplorerPane>
        ) : null}
        <div
          className={maximized && !sheet && evidenceOpen ? "hidden" : "flex min-h-0 min-w-0 flex-1"}
        >
          {props.renderConversation
            ? props.renderConversation(() => {
                closeEvidence();
                props.onDetailsOpenChange(true);
              })
            : props.conversation}
        </div>
        {!sheet && !inspectingSource ? evidence : null}
      </div>
      {sheet || inspectingSource ? (
        <RightPanelSheet animationDurationMs={0} open={evidenceOpen} onClose={closeEvidence}>
          {evidence}
        </RightPanelSheet>
      ) : null}
      {sheet && !inspectingSource ? (
        <RightPanelSheet
          animationDurationMs={0}
          open={props.detailsOpen && !evidenceOpen}
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
            >
              {props.navigation ? (
                <div className="shrink-0 border-b p-3">{props.navigation}</div>
              ) : null}
              {props.source ? (
                <ThreadInspectionContext value={inspectThread}>
                  <Suspense fallback={<p className="p-3 text-xs">Loading agent lineage...</p>}>
                    <div className="shrink-0 border-b p-3">
                      <ThreadRelationshipsPanel
                        environmentId={props.source.environmentId}
                        threadId={props.source.threadId}
                        showLineage
                        showSideChats
                      />
                    </div>
                  </Suspense>
                </ThreadInspectionContext>
              ) : null}
              {props.details}
            </div>
          </div>
        </RightPanelSheet>
      ) : null}
    </div>
  );
}
