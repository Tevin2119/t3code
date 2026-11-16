import { ChevronDownIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { type DeliveryCard, parseCards } from "../../lib/delivery";
import { LANE_TITLE, queryValue } from "../../lib/deliveryBoard";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { useDeliveryEnabled, useDeliveryRead, useStaleReading } from "../../state/delivery";
import { deliveryProgress, parseBoardDelivery } from "../../lib/boardDelivery";

export function useThreadDeliveryProgress(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const enabled = useDeliveryEnabled(environmentId);
  const origin = environmentId && threadId ? `thread:${environmentId}/${threadId}` : null;
  const read = useDeliveryRead(enabled && origin ? environmentId : null, "/api/delivery", {
    pollMs: 10_000,
  });
  const stale = useStaleReading(read.readAt);
  if (read.error || stale || !enabled) return [];
  return (parseBoardDelivery(read.body)?.tracking ?? [])
    .filter((row) => row.request?.origin === origin)
    .map((row) => deliveryProgress(row));
}

/**
 * The tasks a person made from this conversation, newest first. Empty when none was made,
 * when delivery is off, or while the engine has not answered.
 */
export function useThreadTasks(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<DeliveryCard> {
  const enabled = useDeliveryEnabled(environmentId);
  const origin = environmentId && threadId ? `thread:${environmentId}/${threadId}` : null;
  const read = useDeliveryRead(
    enabled && origin ? environmentId : null,
    origin ? `/api/tasks?origin=${queryValue(origin)}&set=all&limit=500` : null,
    { pollMs: 5_000 },
  );
  return [...parseCards(read.body)].sort((a, b) => b.number - a.number);
}

/** Where a task stands, as the Board's column names it. */
export const taskStandsIn = (task: Pick<DeliveryCard, "lane">): string =>
  LANE_TITLE[task.lane ?? ""] ?? task.lane ?? "task";

/** The banner's open actions: the newest task as a button, the rest behind a dropdown. */
export function ThreadTaskOpenActions({
  tasks,
  environmentId,
}: {
  readonly tasks: ReadonlyArray<DeliveryCard>;
  readonly environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  const open = (task: DeliveryCard) =>
    void navigate({ to: "/board", search: { task: task.id, environment: environmentId } });
  const newest = tasks[0];
  if (!newest) return null;
  return (
    <span className="flex items-center gap-1" data-thread-task-open>
      <Button size="xs" variant="ghost" onClick={() => open(newest)}>
        Open #{newest.number}
      </Button>
      {tasks.length > 1 ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Choose a task made from this conversation"
              />
            }
          >
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            {tasks.map((task) => (
              <MenuItem key={task.id} onClick={() => open(task)}>
                <span className="flex max-w-80 flex-col">
                  <span className="truncate">
                    #{task.number} {task.title}
                  </span>
                  <span className="text-xs text-muted-foreground">{taskStandsIn(task)}</span>
                </span>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
    </span>
  );
}
