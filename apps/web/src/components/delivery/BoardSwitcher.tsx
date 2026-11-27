import type { SideThreadOpenIntent } from "@t3tools/client-runtime/side-thread";
import { useGT, useMessages } from "gt-react";
import { CornerDownRightIcon } from "lucide-react";
import type { KeyboardEvent } from "react";

import { BOARD_LANE, boardLaneOf, boardLaneTitle } from "../../lib/boardLanes";
import { WORK_STAGE_TITLE, workStageOf } from "../../lib/boardLaneCards";
import { LANE_TITLE } from "../../lib/deliveryBoard";
import type { SeatThread } from "../../lib/taskConversation";
import { useSideThreadTrigger } from "../../hooks/useSideThreadTrigger";
import { SidebarRowShell } from "../sidebar/SidebarThreadRow";
import type { SwitcherRow } from "./BoardSidebarPanel.logic";

// A row is a button the way a thread row is: Enter or Space opens it, as a click does.
const pressed = (open: () => void) => (event: KeyboardEvent) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  open();
};

function TaskRow(props: {
  readonly row: Extract<SwitcherRow, { kind: "task" }>;
  readonly onOpen: (taskId: string) => void;
}) {
  const m = useMessages();
  const { brief, card } = props.row;
  const lane = boardLaneOf(brief.lane ?? "");
  const stage =
    lane === BOARD_LANE.inWork && card
      ? `${boardLaneTitle(lane, m, LANE_TITLE[lane] ?? brief.state)}, ${m(WORK_STAGE_TITLE[workStageOf(card)])}`
      : boardLaneTitle(lane, m, LANE_TITLE[lane] ?? brief.state);
  const open = () => props.onOpen(brief.id);
  return (
    <li>
      <SidebarRowShell
        role="button"
        tabIndex={0}
        active={props.row.current}
        aria-current={props.row.current ? "page" : undefined}
        indent={props.row.depth}
        dotClassName={props.row.waits ? "bg-warning" : undefined}
        onClick={open}
        onKeyDown={pressed(open)}
        data-board-switcher-task={brief.id}
        data-board-switcher-depth={props.row.depth}
      >
        <span className="shrink-0 font-mono text-3xs text-sidebar-muted-foreground">
          #{brief.number}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{brief.title}</span>
        <span className="max-w-1/3 shrink-0 truncate text-3xs text-sidebar-muted-foreground">
          {stage}
        </span>
      </SidebarRowShell>
    </li>
  );
}

function SeatRow(props: {
  readonly row: Extract<SwitcherRow, { kind: "seat" }>;
  readonly onOpen: (thread: SeatThread, title: string, intent: SideThreadOpenIntent) => void;
}) {
  const gt = useGT();
  const trigger = useSideThreadTrigger();
  const title = gt("Seat {seat}", { seat: props.row.seat });
  const open = (intent: SideThreadOpenIntent) => props.onOpen(props.row.thread, title, intent);
  const handlers = trigger(open);
  return (
    <li>
      <SidebarRowShell
        role="button"
        tabIndex={0}
        indent={props.row.depth}
        {...handlers}
        onKeyDown={(event) => {
          handlers.onKeyDown?.(event);
          if (!event.defaultPrevented) pressed(() => open("primary"))(event);
        }}
        data-board-switcher-seat={props.row.seat}
      >
        <CornerDownRightIcon
          aria-hidden
          className="size-3.5 shrink-0 text-sidebar-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        <span className="shrink-0 text-3xs text-sidebar-muted-foreground">
          {props.row.activity}
        </span>
      </SidebarRowShell>
    </li>
  );
}

/**
 * The board's tasks as rows on the thread row's shell, while a task is open: the open one is the
 * page, and its family is nested under its root. A task row opens its task; a seat row opens its
 * conversation as the task thread's lineage row for it does.
 */
export function BoardSwitcherRows(props: {
  readonly rows: ReadonlyArray<SwitcherRow>;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenSeat: (thread: SeatThread, title: string, intent: SideThreadOpenIntent) => void;
}) {
  return (
    <ul className="flex flex-col" data-board-switcher>
      {props.rows.map((row) =>
        row.kind === "task" ? (
          <TaskRow key={`task:${row.brief.id}`} row={row} onOpen={props.onOpenTask} />
        ) : (
          <SeatRow key={`seat:${row.seat}`} row={row} onOpen={props.onOpenSeat} />
        ),
      )}
    </ul>
  );
}
