export function parseDeliveryEngineHealth(body: unknown) {
  const record: Record<string, unknown> =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const field = (name: string): unknown => record[name] ?? null;
  const code = field("code");
  const commit =
    typeof code === "object" && code !== null && "commit" in code && typeof code.commit === "string"
      ? code.commit
      : null;
  const profile = field("profile");
  const pid = field("pid");
  return {
    stopping: field("stopping") === true,
    profile: typeof profile === "string" ? profile : null,
    pid: typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null,
    commit,
    approval: field("approval") === "passphrase" ? "passphrase" : "terminal-key",
  };
}

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
