import { createFileRoute } from "@tanstack/react-router";

import { OrchestratorPage } from "../components/delivery/OrchestratorPage";
import { isTaskId } from "../lib/deliveryBoard";

export const Route = createFileRoute("/orchestrator")({
  validateSearch: (raw: Record<string, unknown>): { thread?: string } =>
    isTaskId(raw.thread) ? { thread: raw.thread } : {},
  component: OrchestratorPage,
});
