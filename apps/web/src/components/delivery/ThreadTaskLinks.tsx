import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SquareKanbanIcon } from "lucide-react";
import { useMemo } from "react";

import { parseCards } from "../../lib/delivery";
import { LANE_TITLE, queryValue } from "../../lib/deliveryBoard";
import { useDeliveryEnabled, useDeliveryRead } from "../../state/delivery";

/**
 * The tasks a person made from this conversation, each a way to its card. Shown beside the
 * composer of an ordinary thread; nothing is shown when none was made.
 */
export function ThreadTaskLinks(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const enabled = useDeliveryEnabled(props.environmentId);
  const origin = props.environmentId ? `thread:${props.environmentId}/${props.threadId}` : null;
  const read = useDeliveryRead(
    enabled && origin ? props.environmentId : null,
    origin ? `/api/tasks?origin=${queryValue(origin)}&set=all&limit=10` : null,
    { pollMs: 15_000 },
  );
  const tasks = useMemo(() => parseCards(read.body), [read.body]);
  if (tasks.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1" data-thread-task-links>
      {tasks.map((task) => (
        <button
          key={task.id}
          type="button"
          className="inline-flex max-w-44 items-center gap-1 truncate rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          aria-label={`Task #${task.number} made from this conversation, ${LANE_TITLE[task.lane ?? ""] ?? task.lane ?? ""}`}
          onClick={() => void navigate({ to: "/board", search: { task: task.id } })}
        >
          <SquareKanbanIcon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">
            #{task.number} · {LANE_TITLE[task.lane ?? ""] ?? task.lane ?? "task"}
          </span>
        </button>
      ))}
    </span>
  );
}
