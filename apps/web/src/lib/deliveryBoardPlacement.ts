import { parseTarget } from "./delivery";

export function boardPlacementChoices(body: unknown) {
  return (Array.isArray(body) ? body : []).flatMap((item: unknown) =>
    item && typeof item === "object" && "id" in item && "title" in item
      ? [
          {
            id: String(item.id),
            title: String(item.title),
            description: "description" in item ? String(item.description ?? "") : "",
            kind: "own",
            target: "target" in item ? parseTarget(item.target) : null,
          },
        ]
      : [],
  );
}

export function matchingProjectBoard(body: unknown, workspace: string | null | undefined) {
  if (!workspace) return null;
  const normalise = (folder: string) => folder.replace(/\\/g, "/").replace(/\/$/, "");
  const matches = boardPlacementChoices(body).filter(
    (board) =>
      board.target?.ok &&
      board.target.path &&
      normalise(board.target.path) === normalise(workspace),
  );
  return matches.length === 1 ? matches[0]!.id : null;
}
