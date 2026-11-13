import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { canSwitchModelInPlace, latestForkableRun, planModelSwitchFork } from "./switchThreadModel";

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CODEX = ProviderInstanceId.make("codex");
const run = (id: string, status: string) => ({ id: RunId.make(id), status });
const COMPLETED = "completed";
const RUNNING = "running";

describe("planModelSwitchFork", () => {
  it("switches in place before a session starts, whatever the pick", () => {
    expect(
      canSwitchModelInPlace({
        deliveryBinding: { driver: "claudeAgent" },
        supportsProviderSwitchingViaHandoff: false,
        hasStartedSession: false,
        currentProviderInstanceId: CLAUDE,
        nextInstanceId: CODEX,
      }),
    ).toBe(true);
    expect(
      planModelSwitchFork({
        deliveryBinding: { driver: "claudeAgent" },
        supportsProviderSwitchingViaHandoff: false,
        hasStartedSession: false,
        currentProviderInstanceId: CLAUDE,
        nextInstanceId: CODEX,
        runs: [run("r1", COMPLETED)],
      }),
    ).toBeNull();
  });

  it("keeps same-instance picks in place on a started thread", () => {
    expect(
      canSwitchModelInPlace({
        deliveryBinding: { driver: "claudeAgent" },
        supportsProviderSwitchingViaHandoff: false,
        hasStartedSession: true,
        currentProviderInstanceId: CLAUDE,
        nextInstanceId: CLAUDE,
      }),
    ).toBe(true);
  });

  it("keeps cross-instance picks in place when handoff is supported and no binding pins the harness", () => {
    expect(
      canSwitchModelInPlace({
        deliveryBinding: null,
        supportsProviderSwitchingViaHandoff: true,
        hasStartedSession: true,
        currentProviderInstanceId: CLAUDE,
        nextInstanceId: CODEX,
      }),
    ).toBe(true);
    // A delivery binding refuses another harness even with handoff support.
    expect(
      canSwitchModelInPlace({
        deliveryBinding: { driver: "claudeAgent" },
        supportsProviderSwitchingViaHandoff: true,
        hasStartedSession: true,
        currentProviderInstanceId: CLAUDE,
        nextInstanceId: CODEX,
      }),
    ).toBe(false);
  });

  it("forks the newest finished run when the pick cannot stay in this thread", () => {
    const runs = [run("r1", COMPLETED), run("r2", RUNNING), run("r3", "failed")];
    expect(latestForkableRun(runs)?.id).toBe(RunId.make("r3"));
    expect(
      planModelSwitchFork({
        deliveryBinding: { driver: "claudeAgent" },
        supportsProviderSwitchingViaHandoff: false,
        hasStartedSession: true,
        currentProviderInstanceId: CLAUDE,
        nextInstanceId: CODEX,
        runs,
      }),
    ).toBe(RunId.make("r3"));
    // A thread whose runs are still going has nothing to fork: the picker refuses.
    expect(
      planModelSwitchFork({
        deliveryBinding: { driver: "claudeAgent" },
        supportsProviderSwitchingViaHandoff: false,
        hasStartedSession: true,
        currentProviderInstanceId: CLAUDE,
        nextInstanceId: CODEX,
        runs: [run("r2", RUNNING)],
      }),
    ).toBeNull();
    expect(
      planModelSwitchFork({
        deliveryBinding: { driver: "claudeAgent" },
        supportsProviderSwitchingViaHandoff: false,
        hasStartedSession: true,
        currentProviderInstanceId: CLAUDE,
        nextInstanceId: CODEX,
        runs: undefined,
      }),
    ).toBeNull();
  });
});
