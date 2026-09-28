import { createFileRoute } from "@tanstack/react-router";

import { OrchestratorPage } from "../components/delivery/OrchestratorPage";

export const Route = createFileRoute("/orchestrator")({
  validateSearch: (raw: Record<string, unknown>): { thread?: string } =>
    typeof raw.thread === "string" && /^thread-[0-9a-f]+$/.test(raw.thread)
      ? { thread: raw.thread }
      : {},
  component: OrchestratorPage,
});
