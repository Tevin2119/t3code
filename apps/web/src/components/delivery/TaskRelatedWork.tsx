import { ChevronDownIcon, ListTreeIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { boardLaneOf } from "../../lib/boardLanes";
import type { TaskBrief } from "../../lib/delivery";
import { LANE_TITLE } from "../../lib/deliveryBoard";
import { cn } from "../../lib/utils";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { useBoardTask } from "./BoardTaskContext";
import { relatedTaskGroups, taskHasRelatedWork } from "./relatedTaskGroups";
import { laneTone } from "./taskParts";

/** A folding group in the look of the lineage's own groups. */
function RelatedGroup(props: {
  readonly label: string;
  readonly expanded: boolean;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(props.expanded);
  return (
    <div>
      <ThreadDetailsControl aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <ListTreeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
          {props.label}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            THREAD_DETAILS_PANEL_CHEVRON_CLASS,
            "transition-transform",
            !expanded && "-rotate-90",
          )}
        />
      </ThreadDetailsControl>
      {expanded ? <div className="flex flex-col gap-1 pb-1">{props.children}</div> : null}
    </div>
  );
}

/** Board tasks as lineage rows: each one opens that task. */
function RelatedRows(props: {
  readonly title: string;
  readonly tasks: ReadonlyArray<TaskBrief>;
  readonly onOpen: (taskId: string) => void;
}) {
  if (props.tasks.length === 0) return null;
  return (
    <div>
      <p className="px-2.5 pt-1 text-2xs text-muted-foreground">{props.title}</p>
      <ul className="m-0 flex list-none flex-col p-0">
        {props.tasks.map((item) => (
          <li key={item.id}>
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              onClick={() => props.onOpen(item.id)}
              data-related-task={item.id}
            >
              <span aria-hidden className={cn("size-2 rounded-full", laneTone(item.lane).bar)} />
              <span className="font-mono text-2xs text-muted-foreground">#{item.number}</span>
              <span className="min-w-0 flex-1 truncate text-left font-normal">{item.title}</span>
              <span className="text-2xs font-normal text-muted-foreground">
                {LANE_TITLE[boardLaneOf(item.lane ?? "")] ?? item.state}
              </span>
            </ThreadDetailsControl>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The board tasks around this one, from the board's own read: its parent, its current parts and QA
 * follow-ups, then completed and earlier work folded. Child tasks are board tasks, not agents, so
 * the lineage shows them as a group of its own. Dependencies are not children; the Task item has them.
 */
export function TaskRelatedWork() {
  const board = useBoardTask();
  const task = board?.task;
  if (!board || !task || !taskHasRelatedWork(task)) return null;
  const parts = relatedTaskGroups(task.card.parts);
  const followUps = relatedTaskGroups(task.followUps);
  const completed = parts.completed.length + followUps.completed.length;
  const historical = parts.historical.length + followUps.historical.length;
  return (
    <div data-task-related-work>
      <RelatedGroup
        label={`Related work (${parts.current.length} current parts, ${followUps.current.length} QA follow-ups)`}
        expanded
      >
        {task.card.blocker ? (
          <p className="px-2.5 text-xs text-muted-foreground">{task.card.blocker}</p>
        ) : null}
        {task.parent ? (
          <RelatedRows title="Parent task" tasks={[task.parent]} onOpen={board.openTask} />
        ) : null}
        <RelatedRows
          title={`Current parts (${parts.current.length})`}
          tasks={parts.current}
          onOpen={board.openTask}
        />
        <RelatedRows
          title={`QA follow-ups (${followUps.current.length})`}
          tasks={followUps.current}
          onOpen={board.openTask}
        />
      </RelatedGroup>
      {completed > 0 ? (
        <RelatedGroup label={`Completed related work (${completed})`} expanded={false}>
          <RelatedRows title="Completed parts" tasks={parts.completed} onOpen={board.openTask} />
          <RelatedRows
            title="Completed QA follow-ups"
            tasks={followUps.completed}
            onOpen={board.openTask}
          />
        </RelatedGroup>
      ) : null}
      {historical > 0 ? (
        <RelatedGroup label={`Previous or closed work (${historical})`} expanded={false}>
          <p className="px-2.5 text-xs text-muted-foreground">
            Kept for history. Rejected or closed parts are not proof of delivery.
          </p>
          <RelatedRows title="Previous parts" tasks={parts.historical} onOpen={board.openTask} />
          <RelatedRows
            title="Closed QA follow-ups"
            tasks={followUps.historical}
            onOpen={board.openTask}
          />
        </RelatedGroup>
      ) : null}
    </div>
  );
}
