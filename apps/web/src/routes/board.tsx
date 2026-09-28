import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "../components/delivery/BoardPage";

export const Route = createFileRoute("/board")({
  component: BoardPage,
});
