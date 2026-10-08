import type { CheckoutUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  availableUpdateLine,
  CHECKOUT_UPDATE_NOT_STARTED,
  checkoutUpdatePillView,
  checkoutUpdatePresentation,
  checkoutUpdateView,
} from "./CheckoutUpdate.logic";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const idle: CheckoutUpdateState = {
  running: { commit: A, subject: "Older work" },
  available: { commit: B, subject: "Newer work", behind: 3 },
  phase: "idle",
  message: null,
  checkedAt: null,
  lastOutcome: null,
};
const onA: { loadedCommit: string | null; dismissedCommit: string | null } = {
  loadedCommit: A,
  dismissedCommit: null,
};
const pillOptions = { starting: false, startFailed: false, closedKey: null as string | null };
const pill = (state: CheckoutUpdateState | null, options: Partial<typeof onA> = {}) =>
  checkoutUpdatePillView(checkoutUpdateView(state, { ...onA, ...options }), pillOptions);

const undone: CheckoutUpdateState = {
  ...idle,
  phase: "failed",
  message: "bbbbbbb did not start. T3 went back to aaaaaaa.",
  lastOutcome: { from: A, to: B, status: "rolled-back", reason: "bbbbbbb did not start." },
};

describe("availableUpdateLine", () => {
  it.each([
    [{ commit: B, subject: "Newer work", behind: 1 }, "Newer work · 1 new commit"],
    [{ commit: B, subject: "Newer work", behind: 4 }, "Newer work · 4 new commits"],
    [{ commit: B, subject: "", behind: 2 }, "bbbbbbb · 2 new commits"],
  ])("names the commit and how many: %o", (available, line) => {
    expect(availableUpdateLine(available)).toBe(line);
  });
});

describe("checkoutUpdateView", () => {
  it("offers a newer commit until it is dismissed, then offers a newer one again", () => {
    expect(checkoutUpdateView(idle, onA)).toMatchObject({
      kind: "available",
      title: "T3 update available",
      description: "Newer work · 3 new commits",
    });
    expect(checkoutUpdateView(idle, { loadedCommit: A, dismissedCommit: B })).toBeNull();
    const newer = { ...idle, available: { commit: C, subject: "Newest", behind: 4 } };
    expect(checkoutUpdateView(newer, { loadedCommit: A, dismissedCommit: B })?.key).toBe(
      `available:${C}`,
    );
  });

  it("says nothing when the server runs the newest commit", () => {
    expect(checkoutUpdateView({ ...idle, available: null }, onA)).toBeNull();
    expect(checkoutUpdateView(null, onA)).toBeNull();
  });

  it("keeps the offer, or nothing, while the server checks", () => {
    const checking = { ...idle, phase: "checking" as const };
    expect(checkoutUpdateView(checking, onA)?.kind).toBe("available");
    expect(checkoutUpdateView(checking, { loadedCommit: A, dismissedCommit: B })).toBeNull();
  });

  it.each([
    ["installing", "Installing the T3 update"],
    ["building", "Building the T3 update"],
    ["restarting", "Restarting T3"],
  ] as const)("names the %s phase even when the server says more", (phase, title) => {
    const view = checkoutUpdateView({ ...idle, phase, message: "Working on it." }, onA);
    expect(view).toMatchObject({ kind: "progress", title, description: "Working on it." });
  });

  it("says an update that did not start was undone, with why", () => {
    expect(checkoutUpdateView(undone, onA)).toMatchObject({
      kind: "failed",
      title: "T3 update undone",
      description: "bbbbbbb did not start. T3 went back to aaaaaaa.",
    });
    expect(checkoutUpdateView({ ...undone, message: null }, onA)).toMatchObject({
      title: "T3 update undone",
      description: "bbbbbbb did not start.",
    });
  });

  it("says an update that failed before restarting could not be made", () => {
    const failed = { ...idle, phase: "failed" as const, message: "Building the web app failed" };
    expect(checkoutUpdateView(failed, onA)).toMatchObject({
      title: "T3 could not update",
      description: "Building the web app failed",
    });
    // An earlier attempt's undo does not make this failure one.
    const afterEarlierUndo = { ...failed, lastOutcome: undone.lastOutcome };
    expect(checkoutUpdateView(afterEarlierUndo, onA)?.title).toBe("T3 could not update");
    expect(checkoutUpdateView(afterEarlierUndo, onA)?.key).not.toBe(
      checkoutUpdateView(undone, onA)?.key,
    );
  });

  it("asks for a reload once the server runs another commit than the page", () => {
    const updated = { ...idle, running: { commit: B, subject: "Newer work" }, available: null };
    expect(checkoutUpdateView(updated, onA)).toMatchObject({
      kind: "reload",
      description: "Now on bbbbbbb: Newer work. Reload to use it.",
    });
    expect(checkoutUpdateView(updated, { loadedCommit: null, dismissedCommit: null })).toBeNull();
  });
});

describe("checkoutUpdatePillView", () => {
  it("offers the update with a dismiss that remembers the commit", () => {
    expect(pill(idle)).toMatchObject({
      tone: "info",
      title: "T3 update available",
      description: "Newer work · 3 new commits",
      action: "update",
      close: "dismiss",
      notice: null,
    });
    expect(pill(idle, { dismissedCommit: B })).toBeNull();
  });

  it("holds the button while the start request is out, then says when it did not start", () => {
    const view = checkoutUpdateView(idle, onA);
    expect(checkoutUpdatePillView(view, { ...pillOptions, starting: true })).toMatchObject({
      action: "starting",
      close: null,
    });
    expect(checkoutUpdatePillView(view, { ...pillOptions, startFailed: true })).toMatchObject({
      action: "update",
      notice: CHECKOUT_UPDATE_NOT_STARTED,
    });
  });

  it.each(["installing", "building", "restarting"] as const)(
    "shows the %s phase with no action",
    (phase) => {
      expect(pill({ ...idle, phase })).toMatchObject({
        tone: "loading",
        action: null,
        close: null,
      });
    },
  );

  it("shows undone and failed outcomes until closed", () => {
    const view = checkoutUpdateView(undone, onA);
    expect(checkoutUpdatePillView(view, pillOptions)).toMatchObject({
      tone: "error",
      title: "T3 update undone",
      close: "close",
    });
    expect(checkoutUpdatePillView(view, { ...pillOptions, closedKey: view?.key ?? null })).toBe(
      null,
    );
    const failed = { ...idle, phase: "failed" as const, message: "Installing failed" };
    expect(pill(failed)).toMatchObject({ title: "T3 could not update", close: "close" });
  });

  it("offers Reload once the server runs a newer commit", () => {
    const updated = { ...idle, running: { commit: B, subject: "Newer work" }, available: null };
    expect(pill(updated)).toMatchObject({ title: "T3 was updated", action: "reload" });
  });

  it("shows nothing with no update", () => {
    expect(pill({ ...idle, available: null })).toBeNull();
  });
});

describe("checkoutUpdatePresentation", () => {
  const v2 = { settingsHydrated: true, supported: true, legacySidebar: false };
  it.each([
    [{ ...v2, settingsHydrated: false, pathname: "/" }, "none"],
    [{ ...v2, supported: false, pathname: "/" }, "none"],
    [{ ...v2, legacySidebar: true, pathname: "/" }, "toast"],
    [{ ...v2, pathname: "/settings" }, "toast"],
    [{ ...v2, pathname: "/settings/connections" }, "toast"],
    [{ ...v2, pathname: "/settingsx" }, "pill"],
    [{ ...v2, pathname: "/board" }, "pill"],
    [{ ...v2, pathname: "/" }, "pill"],
  ] as const)("%o shows %s", (input, presentation) => {
    expect(checkoutUpdatePresentation(input)).toBe(presentation);
  });
});
