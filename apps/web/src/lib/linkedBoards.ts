/**
 * What the Board shows for a machine this environment links to: the machine's shared boards,
 * what a link's answer and access allow, and the words each diagnostic says. The server reads
 * through the peer link; this narrows its answer the way `lib/delivery` narrows the engine's.
 */
import type {
  AuthMcpClientAccess,
  LinkedDeliveryBoardsResult,
  LinkedDeliveryDiagnostic,
} from "@t3tools/contracts";

/** A machine's shared board as the Board lists it. */
export interface LinkedBoardChoice {
  readonly id: string;
  readonly title: string;
  readonly icon: string | null;
  readonly description: string;
  readonly counts: {
    readonly tasks: number;
    readonly waitingOnYou: number;
    readonly questions: number;
  };
}

/** One link's answer: its shared boards, the link's access, and what went wrong when it did. */
export interface LinkedBoardsLink {
  readonly environmentId: string;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
  readonly diagnostic: LinkedDeliveryDiagnostic | null;
  readonly boards: ReadonlyArray<LinkedBoardChoice>;
}

export type LinkedBoardsAnswer = typeof LinkedDeliveryBoardsResult.Type;

/** The linked machines the boards read answered, in the order it listed them. */
export function linkedBoardsLinks(answer: LinkedBoardsAnswer): ReadonlyArray<LinkedBoardsLink> {
  return answer.links.map((link) => ({
    environmentId: link.environmentId,
    label: link.label,
    access: link.access,
    diagnostic: link.diagnostic,
    boards: link.data?.boards ?? [],
  }));
}

/** What the linked view shows for one machine's boards. */
export type LinkedBoardsState =
  /** The links are still being read; an empty list would say more than is known. */
  | { readonly kind: "unread" }
  | { readonly kind: "blocked"; readonly diagnostic: LinkedDeliveryDiagnostic }
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly boards: ReadonlyArray<LinkedBoardChoice> };

/**
 * One link's answer as the linked view takes it. A link the read did not answer is `null`, so
 * waiting is told apart from a machine that shares nothing.
 */
export function linkedBoardsState(link: LinkedBoardsLink | null): LinkedBoardsState {
  if (link === null) return { kind: "unread" };
  if (link.diagnostic !== null) return { kind: "blocked", diagnostic: link.diagnostic };
  if (link.boards.length === 0) return { kind: "empty" };
  return { kind: "ready", boards: link.boards };
}

/**
 * Whether a diagnostic means the link itself is gone, so a board it had open gives way to the
 * machine's board list with the diagnostic said there. The other diagnostics name one read, and
 * the board that is open stays.
 */
export function linkedDiagnosticLeavesBoard(diagnostic: LinkedDeliveryDiagnostic): boolean {
  return (
    diagnostic === "offline" ||
    diagnostic === "not-linked" ||
    diagnostic === "unauthorized" ||
    diagnostic === "environment-mismatch"
  );
}

/** What a link's diagnostic says, in one quiet line: shown inline, never toasted. */
export const LINKED_DIAGNOSTIC_TEXT: Readonly<Record<LinkedDeliveryDiagnostic, string>> = {
  offline: "Not answering right now.",
  unauthorized: "The link has expired or was revoked. Link it again in Connections settings.",
  "read-only": "This link is read-only: the board can be read, but nothing can be done from here.",
  "not-linked": "No longer linked. Link it again in Connections settings.",
  "environment-mismatch": "A different machine answered than the one this link names.",
  unsupported: "That machine runs a version that does not share boards.",
  "not-found": "The board is no longer shared.",
  refused: "That machine refused the request.",
  "response-too-large": "The answer was too large to read.",
};

/** Whether a link's access allows acting on the machine's boards. Reading is always allowed. */
export const linkedLinkCanAct = (access: AuthMcpClientAccess): boolean => access !== "read-only";

export interface LinkedMachineChoice {
  readonly environmentId: string;
  readonly label: string;
}

/**
 * The machines the environment picker lists as linked. A machine this client is connected to
 * stands as the environment it is there, so it is not listed twice; its local board is the
 * better view of it. A search matches the machine's name, the way the environments' search does.
 */
export function linkedMachineChoices(
  links: ReadonlyMap<string, string>,
  query: string,
  connected: ReadonlyArray<string>,
): ReadonlyArray<LinkedMachineChoice> {
  const own = new Set(connected);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return [...links.entries()]
    .filter(([environmentId]) => !own.has(environmentId))
    .map(([environmentId, label]) => ({ environmentId, label }))
    .filter((machine) => words.every((word) => machine.label.toLowerCase().includes(word)));
}
