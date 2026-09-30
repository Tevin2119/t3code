import { createFileRoute, redirect } from "@tanstack/react-router";

import { isTaskId } from "../lib/deliveryBoard";

/**
 * An earlier address of the Board's task form and task page. Links made to it still work: a
 * task opens on the Board, and without one the Board's New task form opens.
 */
export const Route = createFileRoute("/orchestrator")({
  validateSearch: (raw: Record<string, unknown>): { thread?: string } =>
    isTaskId(raw.thread) ? { thread: raw.thread } : {},
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/board",
      search: search.thread ? { task: search.thread } : { new: true },
      replace: true,
    });
  },
});
