import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "../components/delivery/BoardPage";
import { isConversationRef, isTaskId } from "../lib/deliveryBoard";

export const Route = createFileRoute("/board")({
  // `from` names the conversation a new task is made from: `<environment>/<thread>`.
  validateSearch: (
    raw: Record<string, unknown>,
  ): { task?: string; new?: boolean; from?: string } =>
    isTaskId(raw.task)
      ? { task: raw.task }
      : raw.new === true
        ? isConversationRef(raw.from)
          ? { new: true, from: raw.from }
          : { new: true }
        : {},
  component: BoardPage,
});
