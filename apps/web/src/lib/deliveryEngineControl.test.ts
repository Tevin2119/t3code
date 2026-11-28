import { describe, expect, it, vi } from "vite-plus/test";
import {
  minutesLeft,
  controlDeliveryEngine,
  deliveryEngineDiagnostics,
  deliveryEngineFixPrompt,
  deliveryEngineUpdateStatus,
  deliveryUpdatePending,
  engineAttention,
  parseDeliveryEngineHealth,
  requireDeliveryUpdateReceipt,
} from "./deliveryEngineControl";

describe("engine health summary", () => {
  it("summarizes known fields without carrying arbitrary fields into the summary", () => {
    expect(
      parseDeliveryEngineHealth({
        stopping: false,
        pid: 27290,
        profile: "team",
        approval: "passphrase",
        code: { commit: "9c594ca" },
        unrelated: "private",
      }),
    ).toEqual({
      launcherOwned: false,
      stopping: false,
      pid: 27290,
      profile: "team",
      approval: "passphrase",
      commit: "9c594ca",
      versions: null,
      approvalWindow: null,
      fullAuto: null,
    });
  });

  it.each([null, [], "untyped response", { pid: -1, profile: 7, code: null }])(
    "handles old or unreadable health replies: %j",
    (body) => {
      expect(parseDeliveryEngineHealth(body)).toEqual({
        launcherOwned: false,
        stopping: false,
        pid: null,
        profile: null,
        approval: "terminal-key",
        commit: null,
        versions: null,
        approvalWindow: null,
        fullAuto: null,
      });
    },
  );

  it("identifies a draining engine without implying it can be restarted yet", () => {
    expect(parseDeliveryEngineHealth({ stopping: true }).stopping).toBe(true);
  });
});

describe("release facts and update receipts", () => {
  const versions = {
    channel: "qa" as const,
    running: { commit: "a".repeat(40), changed: false },
    installed: { commit: "b".repeat(40), changed: false },
    available: { commit: "c".repeat(40), at: "2026-10-05T12:00:00Z" },
    updateAvailable: true,
    restartRequired: true,
    deferred: false,
    managed: true,
    pinned: true,
    problem: null,
    update: null,
  };
  it("presents idle, deferred, failed and in-progress facts without guessing completion", () => {
    expect(deliveryEngineUpdateStatus(null, null).kind).toBe("unknown");
    expect(deliveryEngineUpdateStatus(null, "request").kind).toBe("progress");
    expect(deliveryEngineUpdateStatus({ ...versions, updateAvailable: false }, null).kind).toBe(
      "idle",
    );
    expect(deliveryEngineUpdateStatus({ ...versions, deferred: true }, null).text).toContain(
      "deferred",
    );
    expect(deliveryEngineUpdateStatus({ ...versions, problem: "broken catalogue" }, null)).toEqual({
      kind: "error",
      text: "broken catalogue",
    });
    const update = {
      id: "request",
      phase: "failed" as const,
      channel: "qa" as const,
      commit: "c".repeat(40),
      at: "now",
      problem: "failed check output",
    };
    expect(deliveryEngineUpdateStatus({ ...versions, update }, "request")).toEqual({
      kind: "error",
      text: "failed check output",
    });
    expect(
      deliveryEngineUpdateStatus({ ...versions, update: { ...update, phase: "starting" } }, null)
        .kind,
    ).toBe("progress");
    const prompt = deliveryEngineFixPrompt({
      versions: { ...versions, update, mainCheck: { at: "now", reason: "test suite failed" } },
    });
    expect(prompt).toContain("failed check output");
    expect(prompt).toContain("test suite failed");
    expect(prompt).toContain(`${versions.running.commit}..${versions.available.commit}`);
  });
  it("keeps running, installed and available distinct", () => {
    const parsed = parseDeliveryEngineHealth({ code: { commit: "b".repeat(40) }, versions });
    expect(parsed.versions).toEqual(versions);
    expect(parsed.commit).toBe(versions.installed.commit);
    expect(parsed.versions?.running?.commit).not.toBe(parsed.commit);
  });
  it("still offers the next update after a completed one recorded no problem", () => {
    const completed = {
      version: 1,
      id: "request",
      phase: "complete" as const,
      channel: "qa" as const,
      commit: "a".repeat(40),
      at: "2026-11-26T23:51:41.797Z",
      snapshot: "C:\\engine\\snapshots\\request",
      problem: null,
      pid: 15540,
      recovered: true,
    };
    const parsed = parseDeliveryEngineHealth({ versions: { ...versions, update: completed } });
    expect(parsed.versions?.update?.phase).toBe("complete");
    expect(deliveryEngineUpdateStatus(parsed.versions, null).kind).toBe("available");
  });
  it.each([
    { ...versions, channel: "personal" },
    { ...versions, updateAvailable: "true" },
    { ...versions, available: { commit: "not-pinned", at: "now" } },
  ])("does not invent safe controls for invalid release facts", (invalid) => {
    expect(parseDeliveryEngineHealth({ versions: invalid }).versions).toBeNull();
  });
  it("acceptance is only a request receipt, not proof of installation", () => {
    const receipt = { accepted: true, id: "update-1", commit: "a".repeat(40), channel: "main" };
    expect(requireDeliveryUpdateReceipt(receipt)).toEqual(receipt);
    expect("complete" in requireDeliveryUpdateReceipt(receipt)).toBe(false);
  });
  it("does not enable another start during a disconnect or on another update's receipt", () => {
    expect(deliveryUpdatePending("requested", null)).toBe(true);
    expect(deliveryUpdatePending("requested", versions)).toBe(true);
    const update = {
      id: "requested",
      phase: "complete" as const,
      channel: "qa" as const,
      commit: "c".repeat(40),
      at: "now",
    };
    expect(
      deliveryUpdatePending("requested", {
        ...versions,
        channel: "qa",
        update: { ...update, id: "older-update" },
      }),
    ).toBe(true);
    expect(deliveryUpdatePending("requested", { ...versions, channel: "qa", update })).toBe(true);
    expect(
      deliveryUpdatePending("requested", {
        ...versions,
        channel: "qa",
        running: { commit: update.commit, changed: false },
        update,
      }),
    ).toBe(false);
    expect(
      deliveryUpdatePending("requested", {
        ...versions,
        channel: "qa",
        update: { ...update, phase: "starting" },
      }),
    ).toBe(true);
    expect(deliveryUpdatePending(null, null)).toBe(false);
  });
  it.each([null, { stopped: true }, { accepted: true }, { accepted: "true", id: "1" }])(
    "rejects incomplete or lost update acknowledgements",
    (receipt) => {
      expect(() => requireDeliveryUpdateReceipt(receipt)).toThrow("did not confirm");
    },
  );
});

describe("engine restart safety", () => {
  it.each(["stop", "restart"] as const)(
    "refuses unsupported %s without any side effects",
    async (action) => {
      const start = vi.fn();
      const lifecycle = vi.fn();
      await expect(controlDeliveryEngine(action, { start, lifecycle })).rejects.toThrow(
        "Nothing was stopped",
      );
      expect(start).not.toHaveBeenCalled();
      expect(lifecycle).not.toHaveBeenCalled();
    },
  );
  it.each(["stop", "restart"] as const)(
    "accepts launcher-owned %s without a terminal start",
    async (action) => {
      const start = vi.fn();
      const lifecycle = vi.fn().mockResolvedValue({ accepted: true, id: "request-1", action });
      const health = parseDeliveryEngineHealth({ capabilities: { launcherLifecycle: true } });
      expect(health.launcherOwned).toBe(true);
      await controlDeliveryEngine(action, {
        start,
        lifecycle,
        launcherOwned: health.launcherOwned,
      });
      expect(lifecycle).toHaveBeenCalledExactlyOnceWith(action);
      expect(start).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    {},
    { accepted: true, action: "restart" },
    { accepted: true, id: "", action: "restart" },
    { accepted: true, id: "   ", action: "restart" },
    { accepted: true, id: 1, action: "restart" },
    { accepted: false, id: "1", action: "restart" },
    { accepted: true, id: "1", action: "stop" },
  ])("never falls back after an invalid receipt: %j", async (receipt) => {
    const start = vi.fn();
    const lifecycle = vi.fn().mockResolvedValue(receipt);
    await expect(
      controlDeliveryEngine("restart", { start, lifecycle, launcherOwned: true }),
    ).rejects.toThrow("acceptance was not confirmed");
    expect(lifecycle).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });
  it("does not start or retry when the launcher reply is lost", async () => {
    const start = vi.fn();
    const lifecycle = vi.fn().mockRejectedValue(new Error("reply lost"));
    await expect(
      controlDeliveryEngine("restart", { start, lifecycle, launcherOwned: true }),
    ).rejects.toThrow("reply lost");
    expect(lifecycle).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });
  it.each([null, {}, { launcherLifecycle: "true" }, { launcherLifecycle: false }])(
    "does not treat malformed capabilities as ownership",
    (capabilities) => {
      expect(parseDeliveryEngineHealth({ capabilities }).launcherOwned).toBe(false);
    },
  );
  it("keeps explicit start separate", async () => {
    const start = vi.fn();
    const lifecycle = vi.fn();
    await controlDeliveryEngine("start", { start, lifecycle, launcherOwned: true });
    expect(start).toHaveBeenCalledTimes(1);
    expect(lifecycle).not.toHaveBeenCalled();
  });
});

describe("engine diagnostics", () => {
  const checkout = {
    known: true,
    behind: 3,
    upstream: "origin/main",
    fetchedAt: "today",
    text: "behind",
  };
  it("only reports known behind counts, including zero", () => {
    expect(deliveryEngineDiagnostics({ checkout }).freshness).toContain("3 commits behind");
    expect(deliveryEngineDiagnostics({ checkout: { ...checkout, behind: 0 } }).freshness).toContain(
      "0 commits behind",
    );
    for (const value of [
      null,
      { ...checkout, known: false },
      { ...checkout, behind: null },
      { ...checkout, behind: -1 },
    ]) {
      expect(deliveryEngineDiagnostics({ checkout: value }).freshness).toBe(
        "Behind upstream: unknown",
      );
    }
  });
  it("seeds diagnostics without copying approval secrets or arbitrary health fields", () => {
    const prompt = deliveryEngineFixPrompt({
      checkout,
      code: { commit: "abc" },
      key: "SECRET",
      approval: "SECRET",
      arbitrary: { token: "SECRET" },
    });
    expect(prompt).not.toContain("SECRET");
    expect(prompt).toContain("abc");
    expect(prompt).toContain("3 commits behind");
    expect(prompt).toContain("unknown running commit");
    expect(prompt).toContain("full failing-check output or dirty paths");
    expect(prompt).toContain("including .worktrees");
  });
});

describe("diagnostic reading context", () => {
  it("marks unreachable snapshots as potentially stale", () => {
    expect(
      deliveryEngineFixPrompt(null, { reachable: false, error: "Disconnected", readAt: null }),
    ).toContain("Engine health unreachable: Disconnected");
  });
  it("does not claim freshness without a fetch timestamp", () => {
    expect(
      deliveryEngineDiagnostics({
        checkout: { known: true, behind: 0, upstream: "origin/main", fetchedAt: null, text: "" },
      }).freshness,
    ).toBe("Behind upstream: unknown");
  });
});

describe("approval capabilities", () => {
  const older = { by: "Sam", openedAt: "2026-10-19T10:00:00Z", expiresAt: "2026-10-19T10:10:00Z" };
  const newer = { ...older, by: "Alex", expiresAt: "2026-10-19T10:20:00Z" };
  it("selects only the person's window and never falls back", () => {
    const body = {
      approvalWindow: { open: true, windows: [older, newer, { by: "bad", expiresAt: "oops" }] },
    };
    expect(parseDeliveryEngineHealth(body, "Sam").approvalWindow).toEqual({
      open: true,
      by: "Sam",
      until: older.expiresAt,
    });
    expect(parseDeliveryEngineHealth(body).approvalWindow?.by).toBeNull();
    expect(parseDeliveryEngineHealth(body, "Nobody").approvalWindow?.by).toBeNull();
    expect(parseDeliveryEngineHealth(body, "").approvalWindow?.by).toBeNull();
    expect(
      parseDeliveryEngineHealth(
        {
          approvalWindow: {
            open: true,
            windows: [older, { ...older, expiresAt: newer.expiresAt }],
          },
        },
        "Sam",
      ).approvalWindow?.until,
    ).toBe(newer.expiresAt);
    expect(
      parseDeliveryEngineHealth({ approvalWindow: { open: false } }).approvalWindow?.open,
    ).toBe(false);
  });
  it("reads explicit off and attributed on", () => {
    expect(
      parseDeliveryEngineHealth({ fullAuto: { on: false, by: null, since: null } }).fullAuto,
    ).toEqual({ on: false, by: null, since: null });
    const auto = { on: true, by: "Sam", since: older.openedAt };
    expect(parseDeliveryEngineHealth({ fullAuto: auto }).fullAuto).toEqual(auto);
  });
  it.each([
    null,
    [],
    "wrong",
    { open: "true" },
    { open: true, windows: {} },
    { open: true, windows: [{ by: "Sam", expiresAt: "oops" }] },
  ])("ignores unusable window %j", (approvalWindow) => {
    expect(parseDeliveryEngineHealth({ approvalWindow }).approvalWindow).toBeNull();
  });
  it.each([null, [], "wrong", { on: "true" }])("ignores unusable auto %j", (fullAuto) => {
    expect(parseDeliveryEngineHealth({ fullAuto }).fullAuto).toBeNull();
  });
  it("counts remaining minutes without negative ages", () => {
    expect(minutesLeft(older.expiresAt, Date.parse(older.openedAt))).toBe(10);
    expect(minutesLeft(older.expiresAt, Date.parse(newer.expiresAt))).toBe(0);
  });
});

it.each([
  { on: true },
  { on: true, by: "", since: null },
  { on: true, by: "   ", since: "oops" },
  { on: true, by: "Sam", since: "oops" },
  { on: true, by: "", since: "2026-10-19T10:00:00Z" },
])("retains enabled auto with unknown attribution: %j", (fullAuto) => {
  expect(parseDeliveryEngineHealth({ fullAuto }).fullAuto).toEqual({
    on: true,
    by: fullAuto.by?.trim() ? fullAuto.by : null,
    since: fullAuto.since && fullAuto.since !== "oops" ? fullAuto.since : null,
  });
});

describe("engine attention", () => {
  const quiet = {
    channel: "main" as const,
    running: { commit: "a".repeat(40), changed: false },
    installed: { commit: "a".repeat(40), changed: false },
    available: null,
    updateAvailable: false,
    restartRequired: false,
    deferred: false,
    managed: true,
    pinned: false,
    problem: null,
    update: null,
  };
  const ready = {
    ...quiet,
    available: { commit: "c".repeat(40), at: "2026-11-15T09:00:00Z" },
    updateAvailable: true,
  };

  it("asks for nothing when the engine is current or unknown", () => {
    expect(engineAttention(null)).toBeNull();
    expect(engineAttention(quiet)).toBeNull();
  });

  it("names a ready update, and stays quiet once it is put off", () => {
    expect(engineAttention(ready)).toBe("Engine update ready: ccccccc.");
    expect(engineAttention({ ...ready, deferred: true })).toBeNull();
  });

  it("puts a failed update before a ready one", () => {
    const failed = {
      ...ready,
      update: {
        id: "u1",
        phase: "failed" as const,
        channel: "main" as const,
        commit: "c".repeat(40),
        at: "2026-11-15T09:00:00Z",
      },
    };
    expect(engineAttention(failed)).toMatch(/failed/);
  });
});
