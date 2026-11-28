import type { LinkedDeliveryDiagnostic } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  LINKED_DIAGNOSTIC_TEXT,
  linkedBoardsLinks,
  linkedBoardsState,
  linkedDiagnosticLeavesBoard,
  linkedLinkCanAct,
  linkedMachineChoices,
  type LinkedBoardsAnswer,
  type LinkedBoardsLink,
} from "./linkedBoards";

const board = (id: string, title: string) => ({
  id,
  title,
  icon: null,
  description: "",
  counts: { tasks: 1, waitingOnYou: 0, questions: 0 },
});

const answer = (links: ReadonlyArray<Partial<LinkedBoardsLink> & { environmentId: string }>) =>
  ({
    links: links.map((link) => ({
      environmentId: link.environmentId,
      data: link.diagnostic ? null : { boards: link.boards ?? [] },
      diagnostic: link.diagnostic ?? null,
      label: link.label ?? "A machine",
      access: link.access ?? "approval-required",
    })),
    diagnostic: null,
  }) as unknown as LinkedBoardsAnswer;

describe("linkedBoardsLinks", () => {
  it("keeps each link's boards, label and access", () => {
    const links = linkedBoardsLinks(
      answer([{ environmentId: "vps", label: "The VPS", boards: [board("pilot", "Pilot")] }]),
    );
    expect(links).toEqual([
      {
        environmentId: "vps",
        label: "The VPS",
        access: "approval-required",
        diagnostic: null,
        boards: [board("pilot", "Pilot")],
      },
    ]);
  });

  it("reads a link that did not answer as no boards and its diagnostic", () => {
    const links = linkedBoardsLinks(
      answer([{ environmentId: "vps", diagnostic: "offline" as LinkedDeliveryDiagnostic }]),
    );
    expect(links[0]!.boards).toEqual([]);
    expect(links[0]!.diagnostic).toBe("offline");
  });
});

describe("linkedBoardsState", () => {
  it("waits while the links are being read", () => {
    expect(linkedBoardsState(null)).toEqual({ kind: "unread" });
  });

  it("blocks on a diagnostic, and says the machine shares nothing only without one", () => {
    expect(linkedBoardsState({ ...link(), diagnostic: "unauthorized" })).toEqual({
      kind: "blocked",
      diagnostic: "unauthorized",
    });
    expect(linkedBoardsState(link())).toEqual({ kind: "empty" });
  });

  it("is ready with the boards it answered", () => {
    expect(linkedBoardsState({ ...link(), boards: [board("pilot", "Pilot")] })).toEqual({
      kind: "ready",
      boards: [board("pilot", "Pilot")],
    });
  });
});

const link = (): LinkedBoardsLink => ({
  environmentId: "vps",
  label: "The VPS",
  access: "approval-required",
  diagnostic: null,
  boards: [],
});

describe("linkedDiagnosticLeavesBoard", () => {
  it.each(["offline", "not-linked", "unauthorized", "environment-mismatch"] as const)(
    "%s ends the open board",
    (diagnostic) => {
      expect(linkedDiagnosticLeavesBoard(diagnostic)).toBe(true);
    },
  );

  it.each(["read-only", "unsupported", "not-found", "refused", "response-too-large"] as const)(
    "%s names the read, not the link",
    (diagnostic) => {
      expect(linkedDiagnosticLeavesBoard(diagnostic)).toBe(false);
    },
  );
});

describe("linkedLinkCanAct", () => {
  it("allows every access but read-only", () => {
    expect(linkedLinkCanAct("read-only")).toBe(false);
    expect(linkedLinkCanAct("approval-required")).toBe(true);
    expect(linkedLinkCanAct("full-access")).toBe(true);
  });
});

describe("linkedMachineChoices", () => {
  const links = new Map([
    ["vps", "The VPS"],
    ["laptop", "Work laptop"],
  ]);

  it("lists the machines that are not connected environments", () => {
    expect(linkedMachineChoices(links, "", ["laptop"])).toEqual([
      { environmentId: "vps", label: "The VPS" },
    ]);
  });

  it("matches a search in the machine's name", () => {
    expect(linkedMachineChoices(links, "vps", [])).toEqual([
      { environmentId: "vps", label: "The VPS" },
    ]);
    expect(linkedMachineChoices(links, "work", [])).toEqual([
      { environmentId: "laptop", label: "Work laptop" },
    ]);
    expect(linkedMachineChoices(links, "desktop", [])).toEqual([]);
  });
});

describe("LINKED_DIAGNOSTIC_TEXT", () => {
  it("says something for every diagnostic, quietly", () => {
    const diagnostics: ReadonlyArray<LinkedDeliveryDiagnostic> = [
      "offline",
      "unauthorized",
      "read-only",
      "not-linked",
      "environment-mismatch",
      "unsupported",
      "not-found",
      "refused",
      "response-too-large",
    ];
    for (const diagnostic of diagnostics) {
      expect(LINKED_DIAGNOSTIC_TEXT[diagnostic].length).toBeGreaterThan(0);
    }
  });
});
