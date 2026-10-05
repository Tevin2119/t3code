import { describe, expect, it } from "vite-plus/test";
import { controlDeliveryEngine, parseDeliveryEngineHealth } from "./deliveryEngineControl";

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
      });
    },
  );

  it("identifies a draining engine without implying it can be restarted yet", () => {
    expect(parseDeliveryEngineHealth({ stopping: true }).stopping).toBe(true);
  });
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
