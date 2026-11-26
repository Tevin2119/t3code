import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useMessages } from "gt-react";
import { useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { queuePlaces } from "../../lib/boardLaneCards";
import { BOARD_LANE, boardLaneOf, boardLaneTitle, regroupLanes } from "../../lib/boardLanes";
import {
  deliveryEnvironmentChoice,
  parseBoard,
  type DeliveryCard,
  type DeliveryLane,
} from "../../lib/delivery";
import {
  boardSetOf,
  dropTargetLane,
  filterLanes,
  hasFilters,
  type DeliveryBoardSearch,
} from "../../lib/deliveryBoard";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  useBoardStore,
  useBoardPreferences,
  useBoardControls,
  useDeliveryAct,
  useDeliveryEnabled,
  useDeliveryEnvironmentId,
  usePersonName,
  useDeliveryRead,
  useMinuteClock,
  useStaleReading,
} from "../../state/delivery";
import { BoardEngineNotice, BoardNotice, CloseNoticeButton } from "./BoardEngineNotice";
import { EngineAttentionBar } from "./EnginePanel";
import { ArchivedBoardThreads } from "./ArchivedBoardThreads";
import { BoardToolbar } from "./BoardToolbar";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useTaskActions } from "./taskActions";
import { TaskEditor } from "./TaskEditor";
import { TaskWorkspace } from "./TaskWorkspace";
import { ActiveFilterChips } from "./BoardFilterControls";
import { LinkedMovesButton } from "./LinkedTaskMoves";
import { BoardDialog, BoardPicker, type PickerItem } from "./BoardPicker";
import { BoardSeatsDialog } from "./BoardSeatsDialog";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { parseShared } from "../../lib/deliveryShared";
import { unifiedBoardChoices } from "../../lib/deliveryBoardSelection";
import { HowItFits } from "./HowItFits";
import { SharedBoard } from "./SharedBoard";
import { CardFace, Lane } from "./BoardLaneView";
import { LinkedBoardPage } from "./LinkedBoardPage";
import { BoardLinkedVisibilityControls } from "./BoardLinkedVisibilityControls";

import { BoardDeploymentControls, BoardDeploymentSummary } from "./BoardDeploymentControls";
import { MergePermissionControls, MergePermissionSummary } from "./MergePermissionControls";
import { DeploymentSnapshotStale } from "./TaskDeploymentStatus";
import { DeliveryDiagnosticNotice } from "./DeliveryDiagnosticNotice";
import { deliveryReadDiagnostic } from "../../lib/deliveryStates";
import { TaskDisclosure } from "./TaskDisclosure";

/**
 * The delivery board. A lane is where the engine put a card. A card that is
 * dragged asks the engine to submit, pause, resume or triage it again; a
 * lane a card reaches by passing a stage cannot be reached by dragging.
 */
export function BoardPage() {
  const search = useSearch({ strict: false }) as DeliveryBoardSearch;
  // The engine of the environment the work lives in: a conversation's own, when a task is made from one.
  const environmentId = useDeliveryEnvironmentId(
    search.new ? (search.from ?? null) : null,
    search.environment ?? null,
  );
  // A machine this environment links to shows its shared boards through the link instead.
  if (search.linked) {
    return (
      <LinkedBoardPage
        key={`${environmentId ?? "unavailable"}:${search.linked}`}
        environmentId={environmentId}
        linked={search.linked}
      />
    );
  }
  return (
    <EnvironmentBoardPage key={environmentId ?? "unavailable"} environmentId={environmentId} />
  );
}

function BoardColumns(props: {
  readonly environmentId: EnvironmentId | null;
  readonly lanes: ReadonlyArray<DeliveryLane>;
  readonly all: ReadonlyArray<DeliveryLane>;
  readonly busy: boolean;
  readonly onOpen: (card: DeliveryCard) => void;
  readonly onAction: (card: DeliveryCard, action: string) => void;
  readonly onMove: (card: DeliveryCard, lane: string, before: string | null) => void;
}) {
  const now = useMinuteClock();
  const { grouping, laneFolds: folds } = useBoardPreferences(props.environmentId);
  const { foldLane, setFilters } = useBoardControls(props.environmentId);
  const [dragged, setDragged] = useState<DeliveryCard | null>(null);
  const queued = props.all.find((lane) => lane.lane === BOARD_LANE.queue)?.cards;
  const places = useMemo(() => queuePlaces(queued ?? []), [queued]);
  // A press that does not move is a click, which opens the card.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // An empty lane stands folded, so that the lanes with cards fit on the screen. It still
  // takes a card that is dropped on it, and a person may open it or fold any other.
  const isFolded = (lane: DeliveryLane) => folds[lane.lane] ?? lane.cards.length === 0;

  const onDragStart = (event: DragStartEvent) =>
    setDragged((event.active.data.current?.card as DeliveryCard | undefined) ?? null);
  const onDragEnd = (event: DragEndEvent) => {
    const card = dragged;
    setDragged(null);
    const target = event.over?.data.current as
      | { lane?: string; before?: string | null }
      | undefined;
    if (!card || !target?.lane) return;
    if (target.before === card.id) return;
    // Dropped on its own lane and not on a card, it stays where it is.
    if (target.lane === boardLaneOf(card.lane) && !target.before) return;
    // The engine lane the drop is asked of: on a lane, its move; on a card, a reorder when the
    // card stands in the same board lane, and the board lane's move otherwise.
    const to = dropTargetLane(card, target.lane, target.before ?? null);
    props.onMove(card, to, target.before ?? null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragged(null)}
    >
      <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3" data-delivery-board>
        {props.lanes.map((lane) => (
          <Lane
            key={lane.lane}
            environmentId={props.environmentId}
            lane={lane}
            places={places}
            total={props.all.find((item) => item.lane === lane.lane)?.cards.length ?? 0}
            grouping={grouping}
            collapsed={isFolded(lane)}
            dragged={dragged}
            now={now}
            busy={props.busy}
            onToggle={() => foldLane(lane.lane, !isFolded(lane))}
            onOpen={props.onOpen}
            onAction={props.onAction}
            onPickTag={(tag) => setFilters({ tags: [tag] })}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {dragged ? (
          <div className="w-64 rotate-1 cursor-grabbing">
            <CardFace card={dragged} now={now} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function EnvironmentBoardPage({ environmentId }: { readonly environmentId: EnvironmentId | null }) {
  const { environments, isReady } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const defaultEnvironment = deliveryEnvironmentChoice({
    fromConversation: null,
    chosen: null,
    primary,
    isReady,
    connected: environments.map((environment) => environment.environmentId),
  });
  const search = useSearch({ strict: false }) as DeliveryBoardSearch;
  const enabled = useDeliveryEnabled(environmentId);
  const active = enabled ? environmentId : null;
  const setDeliveryEnvironment = useBoardStore((state) => state.setDeliveryEnvironment);
  useEffect(() => {
    if (environmentId) setDeliveryEnvironment(environmentId);
  }, [environmentId, setDeliveryEnvironment]);
  const navigate = useNavigate();
  const preferences = useBoardPreferences(environmentId);
  const { view, filters, grouping, shared, sharedBoardSet } = preferences;
  const {
    setView,
    setFilters,
    clearFilters,
    setGrouping,
    setBoardSet,
    setBoardSelection,
    setSharedBoardSet,
  } = useBoardControls(environmentId);

  const showingBoard = !search.task && !search.new;
  const boardSet = boardSetOf(preferences.boardSet);
  const person = usePersonName();
  const boardAct = useDeliveryAct(active, "board setup");
  // A board or view being made or edited, and what the engine said when it refused.
  const [dialog, setDialog] = useState<{
    readonly kind: "board" | "view";
    readonly editing: PickerItem | null;
  } | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [seatsFor, setSeatsFor] = useState<{ readonly id: string; readonly title: string } | null>(
    null,
  );
  const [dialogProblem, setDialogProblem] = useState<string | null>(null);
  const board = useDeliveryRead(active, `/api/lanes?view=${view}&set=${boardSet}`, {
    pollMs: shared && showingBoard ? 0 : showingBoard ? 4_000 : 15_000,
  });
  const parsed = useMemo(() => parseBoard(board.body), [board.body]);
  const sharedRead = useDeliveryRead(enabled ? active : null, "/api/shared", {
    pollMs: showingBoard && !shared ? 30_000 : 0,
  });
  const sharedView = useMemo(() => parseShared(sharedRead.body), [sharedRead.body]);
  // The boards last read stay listed while another board is being read, one just made with them.
  type KnownBoard = NonNullable<typeof parsed>["sets"][number];
  const [knownBoards, setKnownBoards] = useState<ReadonlyArray<KnownBoard>>([]);
  const [readSets, setReadSets] = useState<ReadonlyArray<KnownBoard> | null>(null);
  if (parsed && parsed.sets !== readSets) {
    setReadSets(parsed.sets);
    setKnownBoards(parsed.sets);
  }
  const m = useMessages();
  // The engine's lanes as the board's 11 (see lib/boardLanes.ts).
  const boardLanes = useMemo(() => regroupLanes(parsed?.lanes ?? []), [parsed]);
  const lanes = useMemo(() => filterLanes(boardLanes, filters), [filters, boardLanes]);
  // The board's lanes, with what each holds before any filter.
  const laneChoices = useMemo(
    () =>
      boardLanes.map((lane) => ({
        lane: lane.lane,
        title: boardLaneTitle(lane.lane, m, lane.title),
        count: lane.cards.length,
      })),
    [boardLanes, m],
  );
  const laneTitle = (lane: string) =>
    laneChoices.find((item) => item.lane === boardLaneOf(lane))?.title ?? lane;
  const stale = useStaleReading(board.readAt);
  const open = (task: string | null) =>
    void navigate({
      to: "/board",
      search: {
        ...(environmentId ? { environment: environmentId } : {}),
        ...(task ? { task } : {}),
      },
    });
  const chooseEnvironment = (environment: string) => {
    setDeliveryEnvironment(environment);
    void navigate({ to: "/board", search: { environment } });
  };
  // A linked machine's boards are read through this environment, so it stays the chosen one.
  const chooseLinkedMachine = (peerEnvironmentId: string) => {
    if (environmentId) setDeliveryEnvironment(environmentId);
    void navigate({
      to: "/board",
      search: {
        ...(environmentId ? { environment: environmentId } : {}),
        linked: peerEnvironmentId,
      },
    });
  };
  const actions = useTaskActions(active, { onDone: board.refresh });
  const chosenBoard = parsed?.sets.find((item) => item.id === boardSet) ?? null;
  // A board or view that was removed, here or elsewhere, gives way to what is always there.
  // The engine refuses a board or view it no longer has, so its refusal also sends the Board back.
  const gone = board.error ?? "";
  useEffect(() => {
    if (/no board "/.test(gone) && boardSet !== "unsorted") setBoardSet("unsorted");
    if (/no view "/.test(gone) && view !== "development") setView("development");
    if (!parsed) return;
    // Only a read made for the current choice says whether it is there: an earlier read does
    // not list a board or view made since, and one that is gone is refused by the engine.
    if (parsed.set === boardSet && !parsed.sets.some((item) => item.id === boardSet)) {
      setBoardSet("unsorted");
    }
    if (parsed.view === view && !parsed.views.some((item) => item.id === view)) {
      setView("development");
    }
  }, [boardSet, gone, parsed, setBoardSet, setView, view]);
  const saveDialog = async (input: {
    readonly title: string;
    readonly description: string;
    readonly lanes?: ReadonlyArray<string>;
    readonly repository?: string;
    readonly workspace?: string;
    readonly base?: string;
  }) => {
    if (!dialog) return;
    setDialogBusy(true);
    setDialogProblem(null);
    const base = dialog.kind === "board" ? "/api/boards" : "/api/views";
    const result = await boardAct(dialog.editing ? `${base}/${dialog.editing.id}/edit` : base, {
      ...input,
      by: person,
    });
    setDialogBusy(false);
    if (!result.ok) {
      setDialogProblem(result.why);
      return;
    }
    const made = result.body as { readonly id?: string } | null;
    if (!dialog.editing && made?.id && dialog.kind === "board") {
      const id = made.id;
      setKnownBoards((boards) => [
        {
          id,
          title: input.title,
          description: input.description,
          kind: "own",
          count: 0,
          target: null,
          linkedVisibility: "private",
        },
        ...boards.filter((item) => item.id !== id),
      ]);
    }
    if (!dialog.editing && made?.id) (dialog.kind === "board" ? setBoardSet : setView)(made.id);
    setDialog(null);
    board.refresh();
  };
  const removeDialog = async () => {
    if (!dialog?.editing) return;
    setDialogBusy(true);
    const base = dialog.kind === "board" ? "/api/boards" : "/api/views";
    const result = await boardAct(`${base}/${dialog.editing.id}/remove`, { by: person });
    setDialogBusy(false);
    if (!result.ok) {
      setDialogProblem(result.why);
      return;
    }
    // What was shown is gone: the Board shows what is always there.
    if (dialog.kind === "board") {
      const gone = dialog.editing.id;
      setKnownBoards((boards) => boards.filter((item) => item.id !== gone));
      if (gone === boardSet) setBoardSet("unsorted");
    }
    if (dialog.kind === "view" && dialog.editing.id === view) setView("development");
    setDialog(null);
    board.refresh();
  };
  const shown = lanes.reduce((sum, lane) => sum + lane.cards.length, 0);

  if (search.new) {
    return (
      <TaskEditor
        environmentId={active}
        taskId={null}
        onClose={() => open(null)}
        onSaved={(task) => {
          // The task was filed in that environment: the board goes on showing it there.
          if (environmentId) setDeliveryEnvironment(environmentId);
          open(task);
        }}
        from="Board"
        fromConversation={search.from ?? null}
        board={
          chosenBoard?.kind === "own" ? { id: chosenBoard.id, title: chosenBoard.title } : null
        }
      />
    );
  }
  if (search.task) {
    return (
      <TaskWorkspace
        key={JSON.stringify([active, search.task])}
        environmentId={active}
        taskId={search.task}
        from="Board"
        onClose={() => open(null)}
        onOpenTask={open}
      />
    );
  }

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <BoardToolbar
            environmentId={active}
            environmentPicker={
              <EnvironmentPicker
                value={environmentId}
                onChoose={chooseEnvironment}
                onChooseLinked={chooseLinkedMachine}
              />
            }
            boardPicker={
              <BoardPicker
                label="Board"
                marker="board"
                items={unifiedBoardChoices(
                  parsed?.sets ??
                    (knownBoards.length > 0
                      ? knownBoards
                      : [{ id: boardSet, title: boardSet, description: "", kind: "built-in" }]),
                  sharedView?.boards ?? [],
                  sharedView?.enabled === true,
                )}
                value={shared ? `shared:${sharedBoardSet}` : `local:${boardSet}`}
                everything={{ id: "local:all", label: "Show every task in this environment" }}
                newLabel="New board…"
                noneYet="You have no boards yet. New board… makes one to group tasks, such as Pilot work; tasks are put on it from New task or a task's page."
                onChoose={setBoardSelection}
                onCreate={() => {
                  setBoardSelection(`local:${boardSet}`);
                  setDialog({ kind: "board", editing: null });
                }}
                onEdit={(item) =>
                  setDialog({ kind: "board", editing: { ...item, id: item.id.slice(6) } })
                }
              />
            }
            viewPicker={
              <BoardPicker
                label="Board view"
                marker="view"
                items={
                  parsed?.views ?? [{ id: view, title: view, description: "", kind: "built-in" }]
                }
                value={view}
                everything={{ id: "development", label: "Show every column" }}
                newLabel="New view…"
                onChoose={setView}
                onCreate={() => setDialog({ kind: "view", editing: null })}
                onEdit={(item) => setDialog({ kind: "view", editing: item })}
              />
            }
            moves={
              active && enabled && !shared ? <LinkedMovesButton environmentId={active} /> : null
            }
            help={
              <>
                {active && !shared ? (
                  <ArchivedBoardThreads environmentId={active} board={boardSet} />
                ) : null}
                <HowItFits />
              </>
            }
            filters={filters}
            grouping={grouping}
            view={view}
            environmentChanged={environmentId !== defaultEnvironment}
            cards={(parsed?.lanes ?? []).flatMap((lane) => lane.cards)}
            lanes={laneChoices}
            waiting={parsed?.waiting ?? 0}
            shared={shared}
            enabled={enabled}
            status={board.readAt ? (stale ? "stale" : "live") : enabled ? "not read yet" : ""}
            pending={board.isPending}
            onFilters={setFilters}
            onGrouping={setGrouping}
            onReset={() => {
              clearFilters();
              setGrouping("none");
              setView("development");
              if (defaultEnvironment && environmentId !== defaultEnvironment)
                chooseEnvironment(defaultEnvironment);
            }}
            onNew={() =>
              void navigate({
                to: "/board",
                search: { new: true, ...(environmentId ? { environment: environmentId } : {}) },
              })
            }
            onRefresh={board.refresh}
          />
        </WorkspacePageHeader>
        {!shared && hasFilters(filters) ? (
          <ActiveFilterChips
            className="px-4 pt-2"
            filters={filters}
            laneTitle={laneTitle}
            shown={shown}
            onClear={(patch) => setFilters(patch)}
            onReset={clearFilters}
          />
        ) : null}

        {!environmentId ? (
          <p className="p-6 text-sm text-muted-foreground">
            {isReady
              ? "This environment is unavailable. Choose an added environment or open Connections settings."
              : "Loading environments..."}
          </p>
        ) : !enabled ? (
          <p className="p-6 text-sm text-muted-foreground">
            Delivery is turned off for this environment. Turn it on in the server settings to see
            the board.
          </p>
        ) : shared ? (
          <SharedBoard
            environmentId={active}
            boardId={sharedBoardSet}
            onChooseBoard={setSharedBoardSet}
            onOpen={open}
          />
        ) : board.error ? (
          deliveryReadDiagnostic(board.failure) === "unreachable" ? (
            <BoardEngineNotice
              className="p-6 text-sm"
              environmentId={environmentId}
              message={`Delivery engine not reachable. ${board.error} Nothing shown here is current.`}
            />
          ) : (
            <DeliveryDiagnosticNotice
              className="min-w-0 space-y-1 p-6 text-sm"
              code={deliveryReadDiagnostic(board.failure)}
              problem={board.error}
            />
          )
        ) : (
          <>
            {actions.problem ? (
              <p
                className="flex items-start gap-2 px-4 pt-2 text-sm text-warning"
                data-delivery-problem
              >
                <span className="min-w-0 flex-1">{actions.problem}</span>
                <button
                  type="button"
                  aria-label="Dismiss"
                  className="cursor-pointer"
                  onClick={actions.clearProblem}
                >
                  <XIcon className="size-3.5" />
                </button>
              </p>
            ) : null}
            {chosenBoard && chosenBoard.id !== "unsorted" && chosenBoard.description ? (
              <p
                className="hidden px-4 pt-2 text-xs text-muted-foreground md:block"
                data-board-set-note
              >
                {chosenBoard.title}: {chosenBoard.description}
              </p>
            ) : null}
            {parsed !== null && parsed.lanes.every((lane) => lane.cards.length === 0) ? (
              <p className="px-4 pt-2 text-xs text-muted-foreground" data-board-empty-pilot>
                {chosenBoard?.kind === "own"
                  ? `Nothing on ${chosenBoard.title} yet. A task made while it is chosen goes on it.`
                  : "Nothing here yet. New task starts some; a board of your own keeps a section of work apart."}
                {(parsed.sets.find((entry) => entry.id === "qualification")?.count ?? 0) > 0
                  ? ` The qualification's ${parsed.sets.find((entry) => entry.id === "qualification")?.count} tasks are kept, as its evidence, under Qualification.`
                  : ""}
              </p>
            ) : null}
            {dialog ? (
              <BoardDialog
                kind={dialog.kind}
                editing={dialog.editing}
                environmentId={active}
                by={person}
                columns={(parsed?.lanes ?? []).map((lane) => ({
                  lane: lane.lane,
                  title: lane.title,
                }))}
                chosenColumns={
                  dialog.editing
                    ? (parsed?.views.find((item) => item.id === dialog.editing?.id)?.lanes ?? [])
                    : []
                }
                busy={dialogBusy}
                problem={dialogProblem}
                onClose={() => {
                  setDialog(null);
                  setDialogProblem(null);
                }}
                onSave={(input) => void saveDialog(input)}
                onRemove={() => void removeDialog()}
                onSeats={() => {
                  const editing = dialog.editing;
                  if (!editing) return;
                  setDialog(null);
                  setDialogProblem(null);
                  setSeatsFor({ id: editing.id, title: editing.title });
                }}
              />
            ) : null}
            {seatsFor ? (
              <BoardSeatsDialog
                environmentId={active}
                board={seatsFor}
                onClose={() => setSeatsFor(null)}
              />
            ) : null}
            {chosenBoard?.kind === "own" ? (
              <div
                key={chosenBoard.id}
                className="mx-4 mt-2 shrink-0 rounded-lg border border-border p-3"
              >
                <TaskDisclosure
                  title={
                    <>
                      Board delivery settings ·{" "}
                      <BoardDeploymentSummary link={chosenBoard.deployment} />
                    </>
                  }
                  defaultOpen={false}
                >
                  <div className="mt-3 grid max-h-80 min-w-0 gap-4 overflow-y-auto md:grid-cols-2">
                    <BoardDeploymentControls
                      environmentId={environmentId}
                      board={chosenBoard.id}
                      target={chosenBoard.target}
                      link={chosenBoard.deployment}
                      stale={stale}
                      onDone={board.refresh}
                    />
                    <MergePermissionControls
                      environmentId={environmentId}
                      path={`/api/boards/${chosenBoard.id}/merge-permission`}
                      policy={chosenBoard.mergePermission}
                      stale={stale}
                      onDone={board.refresh}
                    />
                    <BoardLinkedVisibilityControls
                      environmentId={environmentId}
                      board={chosenBoard.id}
                      visibility={chosenBoard.linkedVisibility}
                      onDone={board.refresh}
                    />
                  </div>
                </TaskDisclosure>
              </div>
            ) : chosenBoard?.mergePermission ? (
              <div className="mx-4 mt-2 shrink-0 text-xs">
                <TaskDisclosure
                  title="Automatic merge permission (read-only board)"
                  defaultOpen={false}
                >
                  <MergePermissionSummary policy={chosenBoard.mergePermission} />
                </TaskDisclosure>
              </div>
            ) : null}
            <EngineAttentionBar environmentId={environmentId} />
            {parsed?.note ? (
              <BoardNotice summary={parsed.note}>
                <p className="px-4 pt-2 text-xs text-muted-foreground">{parsed.note}</p>
              </BoardNotice>
            ) : null}
            {parsed?.notices.map((notice) => (
              <BoardNotice key={notice.key} summary={notice.text}>
                <div className="flex items-start gap-2 px-4 pt-2">
                  <p className="min-w-0 flex-1 text-xs text-warning">
                    {notice.text} Seen {notice.count} time{notice.count === 1 ? "" : "s"}.
                  </p>
                  <CloseNoticeButton
                    environmentId={environmentId}
                    notice={notice}
                    onClosed={board.refresh}
                  />
                </div>
              </BoardNotice>
            ))}
            <DeploymentSnapshotStale value={stale}>
              <BoardColumns
                environmentId={environmentId}
                lanes={lanes}
                all={boardLanes}
                busy={actions.busy}
                onOpen={(card) => open(card.id)}
                onAction={actions.run}
                onMove={(card, lane, before) => actions.moveTo(card, lane, before)}
              />
            </DeploymentSnapshotStale>
          </>
        )}
      </div>
      {actions.dialog}
    </SidebarInset>
  );
}
