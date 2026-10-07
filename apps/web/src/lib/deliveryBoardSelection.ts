export function unifiedBoardChoices(
  local: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly kind: string;
    readonly count?: number | null;
    readonly target?: import("./delivery").DeliveryTarget | null;
  }>,
  shared: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly repository: string;
  }>,
  sharedEnabled: boolean,
) {
  return [
    ...local.map((board) => ({ ...board, id: `local:${board.id}`, scope: "local" as const })),
    ...(sharedEnabled
      ? [
          {
            id: "shared:",
            title: "All shared boards",
            description: "Boards available through this environment's shared connection",
            kind: "shared",
            scope: "shared" as const,
          },
          ...shared.map((board) => ({
            id: `shared:${board.id}`,
            title: board.title,
            description: board.repository,
            kind: "shared",
            scope: "shared" as const,
          })),
        ]
      : []),
  ];
}

export function boardSelectionPatch(value: string) {
  if (value.startsWith("shared:")) return { shared: true, sharedBoardSet: value.slice(7) };
  if (value.startsWith("local:") && value.length > 6)
    return { shared: false, boardSet: value.slice(6) };
  return null;
}
