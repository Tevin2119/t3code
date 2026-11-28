import { T, Var, useGT } from "gt-react";
import { LinkedMovesButton } from "./LinkedTaskMoves";
import { DndContext } from "@dnd-kit/core";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { EnvironmentId, type LinkedDeliveryDiagnostic } from "@t3tools/contracts";
import { useState } from "react";

import { isElectron } from "../../env";
import { queuePlaces } from "../../lib/boardLaneCards";
import { BOARD_LANE, regroupLanes } from "../../lib/boardLanes";
import { parseCard, type DeliveryCard, type DeliveryLane } from "../../lib/delivery";
import { NO_FILTERS, type DeliveryBoardSearch } from "../../lib/deliveryBoard";
import {
  LINKED_DIAGNOSTIC_TEXT,
  linkedBoardsState,
  linkedDiagnosticLeavesBoard,
  type LinkedBoardsState,
  type LinkedBoardChoice,
} from "../../lib/linkedBoards";
import { useDebouncedValue } from "../../state/queries";
import {
  useLinkedBoard,
  useLinkedBoards,
  useLinkedSearch,
  useLinkedTaskCommands,
  useMinuteClock,
} from "../../state/delivery";
import { BoardToolbar } from "./BoardToolbar";
import { BoardPicker } from "./BoardPicker";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { HowItFits } from "./HowItFits";
import { CardFace, Lane } from "./BoardLaneView";
import { LinkedTaskPage } from "./LinkedTaskPage";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const SEARCH_DEBOUNCE_MS = 250;

/**
 * A linked machine's boards, read through the environment the Board already shows: the
 * machine's shared boards to choose from, then the chosen board's lanes and cards in the same
 * pieces the local board uses. The machine is not added as an environment, and no control the
 * link has no answer for is shown: no board settings, no new task, no dragging.
 */
export function LinkedBoardPage(props: {
  readonly environmentId: EnvironmentId | null;
  readonly linked: string;
}) {
  const gt = useGT();
  const peer = EnvironmentId.make(props.linked);
  const search = useSearch({ strict: false }) as DeliveryBoardSearch;
  const navigate = useNavigate();
  const boards = useLinkedBoards(props.environmentId);
  const link = boards.links?.find((machine) => machine.environmentId === props.linked) ?? null;
  const label = link?.label ?? props.linked;
  const state = linkedBoardsState(link);
  const canAct = link !== null && link.access !== "read-only";
  const boardId = search.linkedBoard ?? null;
  const boardRead = useLinkedBoard(props.environmentId, peer, boardId);
  const commands = useLinkedTaskCommands({
    environmentId: props.environmentId,
    peerEnvironmentId: peer,
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const searching = debouncedQuery.length > 0;
  const results = useLinkedSearch(props.environmentId, peer, debouncedQuery, boardId);

  // A link that went away while its board was open gives way to the machine's boards, and the
  // diagnostic is said there.
  const leftBoard =
    boardRead.diagnostic !== null && linkedDiagnosticLeavesBoard(boardRead.diagnostic);

  const open = (task: string | null) =>
    void navigate({
      to: "/board",
      search: {
        ...(props.environmentId ? { environment: props.environmentId } : {}),
        linked: props.linked,
        ...(boardId ? { linkedBoard: boardId } : {}),
        ...(task ? { task } : {}),
      },
    });
  const chooseBoard = (id: string) =>
    void navigate({
      to: "/board",
      search: {
        ...(props.environmentId ? { environment: props.environmentId } : {}),
        linked: props.linked,
        linkedBoard: id,
      },
    });
  const chooseEnvironment = (environment: string) =>
    void navigate({ to: "/board", search: { environment } });
  const chooseLinkedMachine = (peerEnvironmentId: string) =>
    void navigate({
      to: "/board",
      search: {
        ...(props.environmentId ? { environment: props.environmentId } : {}),
        linked: peerEnvironmentId,
      },
    });
  // A card's own menu actions, pause and resume, asked of the machine over the link.
  const runAction = (card: DeliveryCard, action: string) => {
    if (!canAct || !commands.controlAllowed || busyAction) return;
    setBusyAction(true);
    setProblem(null);
    void commands.control(card.id, action as "pause" | "resume").then((outcome) => {
      setBusyAction(false);
      setProblem(
        outcome.ok
          ? (outcome.message ?? (outcome.diagnostic && LINKED_DIAGNOSTIC_TEXT[outcome.diagnostic]))
          : outcome.why,
      );
      boardRead.refresh();
    });
  };

  if (search.task) {
    return (
      <LinkedTaskPage
        environmentId={props.environmentId}
        peerEnvironmentId={peer}
        taskId={search.task}
        machine={label}
        allowed={canAct}
        readOnly={link?.access === "read-only"}
        onBack={() => open(null)}
        onOpenTask={open}
      />
    );
  }

  const diagnostics = new Map<string, LinkedDeliveryDiagnostic | null>(
    (boards.links ?? []).map((machine) => [machine.environmentId, machine.diagnostic]),
  );
  const showingBoard = boardId !== null && !leftBoard && !searching;
  const pickerItems =
    state.kind === "ready"
      ? state.boards.map((board) => ({
          id: `linked:${board.id}`,
          title: board.title,
          description: board.description,
          kind: "linked",
          count: board.counts.tasks,
        }))
      : [];

  return (
    <SidebarInset>
      <div className="isolate flex h-dvh min-h-0 min-w-0 flex-1 flex-col overflow-hidden overscroll-y-none">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <BoardToolbar
            environmentId={null}
            environmentPicker={
              <EnvironmentPicker
                value={props.environmentId}
                onChoose={chooseEnvironment}
                linkedValue={props.linked}
                onChooseLinked={chooseLinkedMachine}
                linkedDiagnostics={diagnostics}
              />
            }
            boardPicker={
              showingBoard && boardRead.board ? (
                <BoardPicker
                  label={gt("Board")}
                  marker="linked-board"
                  items={pickerItems}
                  value={`linked:${boardId}`}
                  onChoose={(id) => id.startsWith("linked:") && chooseBoard(id.slice(7))}
                />
              ) : (
                <span className="max-w-48 min-w-0 truncate text-xs text-muted-foreground">
                  {label}
                  <T> · shared boards</T>
                </span>
              )
            }
            viewPicker={null}
            help={<HowItFits />}
            moves={
              props.environmentId ? <LinkedMovesButton environmentId={props.environmentId} /> : null
            }
            filters={{ ...NO_FILTERS, q: query }}
            grouping="none"
            view="development"
            environmentChanged={false}
            cards={[]}
            lanes={[]}
            waiting={0}
            shared={false}
            linked
            enabled
            status={boardRead.isPending ? "reading" : "snapshot"}
            pending={boardRead.isPending}
            onFilters={(patch) => {
              if (patch.q !== undefined) setQuery(patch.q);
            }}
            onGrouping={() => {}}
            onReset={() => setQuery("")}
            onNew={() => {}}
            onRefresh={boardRead.refresh}
          />
        </WorkspacePageHeader>

        {link?.access === "read-only" && (
          <p className="px-4 pt-2 text-xs text-muted-foreground">
            <T>This link is read-only.</T>
          </p>
        )}
        {problem ? (
          <p
            className="flex items-start gap-2 px-4 pt-2 text-xs text-warning"
            data-delivery-problem
          >
            <span className="min-w-0 flex-1">{problem}</span>
            <button type="button" className="cursor-pointer" onClick={() => setProblem(null)}>
              <T>Dismiss</T>
            </button>
          </p>
        ) : null}

        {!props.environmentId ? (
          <p className="p-6 text-sm text-muted-foreground">
            <T>
              This environment is unavailable. Choose an added environment or open Connections
              settings.
            </T>
          </p>
        ) : boards.error ? (
          <p className="p-6 text-sm text-muted-foreground">
            <T>The linked machines could not be read. </T>
            {boards.error}
          </p>
        ) : searching ? (
          <LinkedSearchResults
            cards={results.cards?.map((card) => parseCard({ ...card, set: card.board.id })) ?? []}
            diagnostic={results.diagnostic}
            pending={results.isPending}
            onOpen={(card) => open(card.id)}
          />
        ) : showingBoard && boardRead.diagnostic ? (
          leftBoard ? (
            <div className="space-y-3 p-6" data-linked-left-board>
              <p className="text-sm text-muted-foreground" data-linked-diagnostic>
                {LINKED_DIAGNOSTIC_TEXT[boardRead.diagnostic]}
              </p>
              <LinkedBoardsList
                state={state}
                label={label}
                onChoose={chooseBoard}
                onRefresh={boards.refresh}
              />
            </div>
          ) : (
            <p className="p-6 text-sm text-muted-foreground" data-linked-diagnostic>
              {LINKED_DIAGNOSTIC_TEXT[boardRead.diagnostic]}
            </p>
          )
        ) : showingBoard && boardRead.board ? (
          <LinkedBoardColumns
            environmentId={props.environmentId}
            lanes={regroupLanes(
              boardRead.board.lanes.map((lane) => ({
                lane: lane.lane,
                title: lane.title,
                cards: lane.cards.map((card) =>
                  parseCard({
                    ...card,
                    set: card.board.id,
                    actions: canAct && commands.controlAllowed ? card.actions : [],
                  }),
                ),
              })),
            )}
            busy={busyAction}
            onOpen={(card) => open(card.id)}
            onAction={runAction}
            onPickTag={(tag) => setQuery(tag)}
          />
        ) : (
          <LinkedBoardsList
            state={state}
            label={label}
            onChoose={chooseBoard}
            onRefresh={boards.refresh}
          />
        )}
      </div>
    </SidebarInset>
  );
}

/**
 * The machine's shared boards to choose from. What a link's answer came to is said here, not
 * toasted: still being read, a diagnostic, or none shared, each in one quiet line.
 */
function LinkedBoardsList(props: {
  readonly state: LinkedBoardsState;
  readonly label: string;
  readonly onChoose: (id: string) => void;
  readonly onRefresh?: () => void;
}) {
  const { state } = props;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-6" data-linked-boards>
      <p className="text-xs text-muted-foreground">
        <T>
          Boards <Var>{props.label}</Var> shares with machines linked to it. The machine that owns a
          board chooses whether to share it.
        </T>
      </p>
      {state.kind === "unread" ? (
        <p className="text-sm text-muted-foreground" role="status">
          <T>
            Reading <Var>{props.label}</Var>&apos;s boards...
          </T>
        </p>
      ) : null}
      {state.kind === "blocked" ? (
        <p className="text-sm text-warning-foreground" data-linked-diagnostic>
          {LINKED_DIAGNOSTIC_TEXT[state.diagnostic]}
        </p>
      ) : null}
      {state.kind === "empty" ? (
        <p className="text-sm text-muted-foreground">
          <T>
            No boards are shared with this machine. <Var>{props.label}</Var> chooses which boards it
            shares.
          </T>
        </p>
      ) : null}
      {state.kind === "ready"
        ? state.boards.map((board) => (
            <LinkedBoardRow key={board.id} board={board} onChoose={props.onChoose} />
          ))
        : null}
      {props.onRefresh ? (
        <button
          type="button"
          className="self-start cursor-pointer text-xs text-muted-foreground underline"
          onClick={props.onRefresh}
          data-linked-boards-refresh
        >
          <T>Read the machines again</T>
        </button>
      ) : null}
    </div>
  );
}

function LinkedBoardRow(props: {
  readonly board: LinkedBoardChoice;
  readonly onChoose: (id: string) => void;
}) {
  const gt = useGT();
  const { board } = props;
  return (
    <button
      type="button"
      className="flex min-w-0 flex-col items-start gap-0.5 rounded-md border border-border p-3 text-left hover:bg-accent/60"
      onClick={() => props.onChoose(board.id)}
      data-linked-board={board.id}
    >
      <span className="flex w-full items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{board.title}</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
          {board.counts.tasks}
        </span>
      </span>
      {board.description ? (
        <span className="line-clamp-2 text-xs text-muted-foreground">{board.description}</span>
      ) : null}
      <span className="text-xs text-muted-foreground">
        {gt("{count, plural, one {{count} task} other {{count} tasks}}", {
          count: board.counts.tasks,
        })}
        {board.counts.waitingOnYou > 0
          ? gt(" · {count} waiting on you", { count: board.counts.waitingOnYou })
          : ""}
        {board.counts.questions > 0
          ? gt(" · {count} questions", { count: board.counts.questions })
          : ""}
      </span>
    </button>
  );
}

/** What the machine's search answered, as cards the same pieces render. */
function LinkedSearchResults(props: {
  readonly cards: ReadonlyArray<DeliveryCard>;
  readonly diagnostic: LinkedDeliveryDiagnostic | null;
  readonly pending: boolean;
  readonly onOpen: (card: DeliveryCard) => void;
}) {
  const now = useMinuteClock();
  if (props.diagnostic) {
    return (
      <p className="p-6 text-sm text-muted-foreground" data-linked-diagnostic>
        {LINKED_DIAGNOSTIC_TEXT[props.diagnostic]}
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-6" data-linked-search>
      {props.pending && props.cards.length === 0 ? (
        <p className="text-sm text-muted-foreground" role="status">
          <T>Searching...</T>
        </p>
      ) : null}
      {props.cards.map((card) => (
        <div
          key={card.id}
          role="button"
          tabIndex={0}
          aria-label={`#${card.number} ${card.title}`}
          className="w-72 cursor-pointer rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset"
          onClick={() => props.onOpen(card)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.target === event.currentTarget) props.onOpen(card);
          }}
          data-linked-search-card={card.id}
        >
          <CardFace card={card} now={now} />
        </div>
      ))}
      {!props.pending && props.cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <T>No matching tasks.</T>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The linked board's lanes: the same lane and card pieces the local board uses, with no drag
 * sensors, so a card opens on a click and nothing offers to move it.
 */
function LinkedBoardColumns(props: {
  readonly environmentId: EnvironmentId | null;
  readonly lanes: ReadonlyArray<DeliveryLane>;
  readonly busy: boolean;
  readonly onOpen: (card: DeliveryCard) => void;
  readonly onAction: (card: DeliveryCard, action: string) => void;
  readonly onPickTag: (tag: string) => void;
}) {
  const now = useMinuteClock();
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const queued = props.lanes.find((lane) => lane.lane === BOARD_LANE.queue)?.cards;
  const places = queuePlaces(queued ?? []);
  const isFolded = (lane: DeliveryLane) => folds[lane.lane] ?? lane.cards.length === 0;
  return (
    <DndContext onDragEnd={() => {}}>
      <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3" data-delivery-board>
        {props.lanes.map((lane) => (
          <Lane
            key={lane.lane}
            environmentId={props.environmentId}
            lane={lane}
            places={places}
            total={lane.cards.length}
            grouping="none"
            collapsed={isFolded(lane)}
            dragged={null}
            now={now}
            busy={props.busy}
            onToggle={() => setFolds((current) => ({ ...current, [lane.lane]: !isFolded(lane) }))}
            onOpen={props.onOpen}
            onAction={props.onAction}
            onPickTag={props.onPickTag}
          />
        ))}
      </div>
    </DndContext>
  );
}
