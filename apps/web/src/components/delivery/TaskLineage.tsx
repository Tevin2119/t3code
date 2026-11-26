import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ArrowRightIcon, CornerLeftUpIcon } from "lucide-react";

import type { TaskView } from "../../lib/delivery";
import { useQuietThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ThreadRelationshipIcon } from "../chat/ThreadRelationshipIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useBoardTask } from "./BoardTaskContext";
import { taskHasLineage } from "./relatedTaskGroups";
import { useSeatCatalog } from "./SeatSettingsPanel";
import { TaskRelatedWork } from "./TaskRelatedWork";
import { SeatThreadRow } from "./TaskTeamActivity";
import { useOpenSeatThread } from "./useTaskConversation";

/** The conversation the task was filed from. It opens at its own route, as a fork's source does. */
function SourceRow(props: { readonly source: NonNullable<TaskView["source"]> }) {
  const gt = useGT();
  const navigate = useNavigate();
  const ref = scopeThreadRef(
    EnvironmentId.make(props.source.environmentId),
    ThreadId.make(props.source.threadId),
  );
  const title = useQuietThreadShell(ref)?.title ?? gt("The conversation this task came from");
  return (
    <li className="group relative flex h-8 items-center rounded-lg">
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(ref),
                })
              }
              data-task-source-thread
            />
          }
        >
          <ThreadRelationshipIcon fallbackIcon={CornerLeftUpIcon} status={null} />
          <span className="min-w-0 flex-1 truncate text-left text-sm font-medium leading-4 text-foreground/85">
            {title}
          </span>
          <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </TooltipTrigger>
        <TooltipPopup side="left">
          <span className="block font-medium">{title}</span>
          <span className="block text-muted-foreground">
            {gt("Open the conversation this task was filed from")}
          </span>
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}

/**
 * What a board task adds to its thread's lineage: the conversation it was filed from, the seats'
 * own conversations the thread does not list as subagents, then the board tasks around it.
 */
export function TaskLineage() {
  const board = useBoardTask();
  const catalog = useSeatCatalog(board?.environmentId ?? null);
  const openSeat = useOpenSeatThread(board?.thread ?? null);
  if (!taskHasLineage(board)) return null;
  const { task } = board;
  const seats = task.council?.seats ?? [];
  const rows = board.seats.rows.flatMap((row) => {
    const seat = seats.find((item) => item.seat === row.seat);
    return seat ? [{ ...row, council: seat }] : [];
  });
  return (
    <div data-task-lineage>
      {task.source || rows.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {task.source ? <SourceRow source={task.source} /> : null}
          {rows.map((row) => (
            <SeatThreadRow
              key={row.seat}
              seat={row.council}
              catalog={catalog}
              onOpen={(intent) => openSeat(row.target, row.seat, intent)}
            />
          ))}
        </ul>
      ) : null}
      <TaskRelatedWork />
    </div>
  );
}
