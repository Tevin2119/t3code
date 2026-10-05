import { describe, expect, it } from "vite-plus/test";
import { controlDeliveryEngine } from "./deliveryEngineControl";

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
