import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "../components/delivery/BoardPage";
import { isTaskId } from "../lib/deliveryBoard";

export const Route = createFileRoute("/board")({
  validateSearch: (raw: Record<string, unknown>): { task?: string; new?: boolean } =>
    isTaskId(raw.task) ? { task: raw.task } : raw.new === true ? { new: true } : {},
  component: BoardPage,
});
