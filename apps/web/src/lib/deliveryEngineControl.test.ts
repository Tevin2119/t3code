import { describe, expect, it } from "vite-plus/test";
import {
  minutesLeft,
  controlDeliveryEngine,
  deliveryUpdatePending,
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
  it("keeps running, installed and available distinct", () => {
    const parsed = parseDeliveryEngineHealth({ code: { commit: "b".repeat(40) }, versions });
    expect(parsed.versions).toEqual(versions);
    expect(parsed.commit).toBe(versions.installed.commit);
    expect(parsed.versions?.running?.commit).not.toBe(parsed.commit);
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
  it("does not start while stop is still draining", async () => {
    let acknowledge: (value: unknown) => void = () => {};
    const drained = new Promise<unknown>((resolve) => {
      acknowledge = resolve;
    });
    let starts = 0;
    const restart = controlDeliveryEngine("restart", {
      stop: () => drained,
      start: async () => {
        starts++;
      },
    });
    expect(starts).toBe(0);
    acknowledge({ stopped: true });
    await restart;
    expect(starts).toBe(1);
  });

  it.each([null, {}, { stopping: true }, { stopped: false }, { stopped: "true" }])(
    "does not treat an incomplete stop as permission to restart: %j",
    async (receipt) => {
      let starts = 0;
      await expect(
        controlDeliveryEngine("restart", {
          stop: async () => receipt,
          start: async () => {
            starts++;
          },
        }),
      ).rejects.toThrow("completed stop");
      expect(starts).toBe(0);
    },
  );

  it("a lost stop reply never launches another process", async () => {
    let starts = 0;
    await expect(
      controlDeliveryEngine("restart", {
        stop: async () => {
          throw new Error("reply lost");
        },
        start: async () => {
          starts++;
        },
      }),
    ).rejects.toThrow("reply lost");
    expect(starts).toBe(0);
  });

  it("stop alone never restarts the engine", async () => {
    let starts = 0;
    await controlDeliveryEngine("stop", {
      stop: async () => ({ stopped: true }),
      start: async () => {
        starts++;
      },
    });
    expect(starts).toBe(0);
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
  it.each([
    null,
    [],
    "wrong",
    { on: "true" },
    { on: true },
    { on: true, by: "Sam", since: "oops" },
  ])("ignores unusable auto %j", (fullAuto) => {
    expect(parseDeliveryEngineHealth({ fullAuto }).fullAuto).toBeNull();
  });
  it("counts remaining minutes without negative ages", () => {
    expect(minutesLeft(older.expiresAt, Date.parse(older.openedAt))).toBe(10);
    expect(minutesLeft(older.expiresAt, Date.parse(newer.expiresAt))).toBe(0);
  });
});
