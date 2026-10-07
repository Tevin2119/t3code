import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "../components/delivery/BoardPage";
import { parseBoardSearch } from "../lib/deliveryBoard";

export const Route = createFileRoute("/board")({
  validateSearch: parseBoardSearch,
  component: BoardPage,
});
