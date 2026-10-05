export async function controlDeliveryEngine(
  action: "start" | "stop" | "restart",
  operations: {
    readonly stop: () => Promise<unknown>;
    readonly start: () => Promise<void>;
  },
): Promise<void> {
  if (action !== "start") {
    const receipt = await operations.stop();
    if (
      typeof receipt !== "object" ||
      receipt === null ||
      !("stopped" in receipt) ||
      receipt.stopped !== true
    ) {
      throw new Error("The engine did not confirm a completed stop. Nothing else was started.");
    }
  }
  if (action !== "stop") await operations.start();
}
