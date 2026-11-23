import { useNavigate } from "@tanstack/react-router";
import { useMessages } from "gt-react";
import { SquareKanbanIcon } from "lucide-react";

import { parseCards } from "../lib/delivery";
import { boardSetOf } from "../lib/deliveryBoard";
import {
  useBoardPreferences,
  useDeliveryEnabled,
  useDeliveryEnvironmentId,
  useDeliveryRead,
} from "../state/delivery";
import {
  boardTaskSearchPath,
  buildBoardTaskActionItems,
  ITEM_ICON_CLASS,
} from "./CommandPalette.logic";

/**
 * The board's tasks for a palette search, from the search the board's own list makes. It is read
 * only while there is something to search for; with no board there is nothing to list.
 */
export function useCommandPaletteTaskItems(searchQuery: string) {
  const navigate = useNavigate();
  const messages = useMessages();
  const environmentId = useDeliveryEnvironmentId();
  const enabled = useDeliveryEnabled(environmentId);
  const { boardSet, shared } = useBoardPreferences(environmentId);
  const path = boardTaskSearchPath(searchQuery, boardSetOf(boardSet));
  const read = useDeliveryRead(enabled && !shared && path ? environmentId : null, path);
  return buildBoardTaskActionItems(
    {
      tasks: parseCards(read.body),
      icon: <SquareKanbanIcon className={ITEM_ICON_CLASS} />,
      runTask: async (taskId) => {
        await navigate({
          to: "/board",
          search: environmentId ? { environment: environmentId, task: taskId } : { task: taskId },
        });
      },
    },
    messages,
  );
}
