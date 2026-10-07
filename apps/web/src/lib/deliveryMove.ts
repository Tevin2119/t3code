import type { DeliveryTarget } from "./delivery";

/** The board triage thinks a task belongs on. The task waits on a person until it is moved. */
export interface SuggestedBoard {
  readonly id: string;
  readonly title: string;
  readonly repository: string;
  readonly base: string | null;
}

export function parseSuggestedBoard(value: unknown): SuggestedBoard | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id) return null;
  const repository = typeof item.repository === "string" ? item.repository : "";
  return {
    id: item.id,
    title: typeof item.title === "string" && item.title ? item.title : item.id,
    repository,
    base: typeof item.base === "string" && item.base ? item.base : null,
  };
}

/** A board of a person's own, with where its tasks are done when the engine says. */
export interface MoveBoard {
  readonly id: string;
  readonly title: string;
  readonly target: DeliveryTarget | null;
}

/**
 * What choosing a board does to a task. Putting it on a board done in the same repository only
 * places it ("place"). A board done elsewhere, or one whose repository is not known, moves the
 * task's work there, which a person confirms first ("move"). Taking it off every board places it.
 */
export function boardChoiceKind(
  taskRepository: string | null,
  board: MoveBoard | null,
): "place" | "move" {
  if (!board) return "place";
  const repository = board.target?.repository ?? null;
  if (!repository || !taskRepository) return "move";
  return repository === taskRepository ? "place" : "move";
}

/** What moving the task does, said before a person confirms it. */
export function moveOutcomeLine(input: {
  readonly isDraft: boolean;
  readonly to: string | null;
  readonly from: string | null;
}): string {
  const to = input.to ?? "the repository of that board";
  if (input.isDraft) return `It stays a draft, done in ${to}.`;
  const kept = input.from
    ? ` Anything built for ${input.from} stays as history.`
    : " Anything built before stays as history.";
  return `It will be done in ${to} and goes back to triage.${kept}`;
}

/** The body of a move: an empty base means the board's own base branch. */
export function relocateBody(input: {
  readonly board: string;
  readonly base: string;
  readonly by: string;
}): { readonly board: string; readonly base: string | null; readonly by: string } {
  const base = input.base.trim();
  return { board: input.board, base: base || null, by: input.by };
}
