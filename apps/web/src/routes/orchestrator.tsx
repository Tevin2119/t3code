import { createFileRoute, redirect } from "@tanstack/react-router";

import { isTaskId } from "../lib/deliveryBoard";

// Keep links to existing tasks; a bare orchestration link starts a native conversation.
export const Route = createFileRoute("/orchestrator")({
  validateSearch: (raw: Record<string, unknown>): { thread?: string } =>
    isTaskId(raw.thread) ? { thread: raw.thread } : {},
  beforeLoad: ({ search }) => {
    if (search.thread) {
      throw redirect({ to: "/board", search: { task: search.thread }, replace: true });
    }
    throw redirect({ to: "/", replace: true });
  },
});
