import { useBoardTask } from "./BoardTaskContext";
import { taskHasLineage } from "./relatedTaskGroups";
import { useSeatCatalog } from "./SeatSettingsPanel";
import { TaskRelatedWork } from "./TaskRelatedWork";
import { SeatThreadRow } from "./TaskTeamActivity";
import { useOpenSeatThread } from "./useTaskConversation";

/**
 * What a board task adds to its thread's lineage: the seats' own conversations the thread does not
 * list as subagents, then the conversation it was made from and the board tasks around it.
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
      {rows.length > 0 ? (
        <ul className="m-0 list-none p-0">
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
