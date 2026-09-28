import { createFileRoute } from "@tanstack/react-router";

import { OrchestratorPage } from "../components/delivery/OrchestratorPage";

export const Route = createFileRoute("/orchestrator")({
  component: OrchestratorPage,
});
