import { createLucideIcon } from "lucide-react";

/**
 * The Board: a frame with a header row and columns of cards hanging from it. Drawn here
 * because the Kanban glyph of lucide is three bars, which reads as the usage chart beside it.
 */
export const BoardIcon = createLucideIcon("delivery-board", [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "board" }],
  ["path", { d: "M3 8h18", key: "header" }],
  ["rect", { width: "3", height: "6", x: "6", y: "11", rx: "1", key: "card-todo" }],
  ["rect", { width: "3", height: "3", x: "10.5", y: "11", rx: "1", key: "card-doing" }],
  ["rect", { width: "3", height: "4.5", x: "15", y: "11", rx: "1", key: "card-done" }],
]);
