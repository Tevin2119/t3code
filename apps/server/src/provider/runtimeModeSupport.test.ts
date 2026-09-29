import { describe, expect, it } from "vite-plus/test";

import { buildDeepSeekAcpSpawnInput } from "./acp/DeepSeekAcpSupport.ts";
import { codexSandboxProblemFrom } from "./Layers/codexSandboxCheck.ts";
import {
  codexRuntimeModes,
  DEEPSEEK_RUNTIME_MODES,
  HERMES_RUNTIME_MODES,
  KIMI_RUNTIME_MODES,
  OPENCODE_RUNTIME_MODES,
  PI_RUNTIME_MODES,
  runtimeModeProblem,
  runtimeModeSupport,
} from "./runtimeModeSupport.ts";

const available = (support: ReturnType<typeof runtimeModeSupport>) =>
  support.filter((item) => item.available).map((item) => item.mode);

describe("runtimeModeSupport", () => {
  it("names every mode, and gives a reason with each one that is unavailable", () => {
    for (const support of [
      PI_RUNTIME_MODES,
      KIMI_RUNTIME_MODES,
      DEEPSEEK_RUNTIME_MODES,
      HERMES_RUNTIME_MODES,
      OPENCODE_RUNTIME_MODES,
      codexRuntimeModes("the pipe timed out"),
    ]) {
      expect(support.map((item) => item.mode)).toEqual([
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]);
      for (const item of support) {
        expect(Boolean(item.reason)).toBe(!item.available);
      }
    }
  });

  it("offers pi full access only, since pi has no way to ask and no sandbox", () => {
    expect(available(PI_RUNTIME_MODES)).toEqual(["full-access"]);
    expect(runtimeModeProblem(PI_RUNTIME_MODES, "approval-required")).toContain(
      "would run with full access",
    );
    expect(runtimeModeProblem(PI_RUNTIME_MODES, "full-access")).toBeUndefined();
  });

  it("offers the ACP providers the two modes they can honour", () => {
    for (const support of [KIMI_RUNTIME_MODES, DEEPSEEK_RUNTIME_MODES, HERMES_RUNTIME_MODES]) {
      expect(available(support)).toEqual(["approval-required", "full-access"]);
    }
  });

  it("offers OpenCode everything but a reviewer it does not have", () => {
    expect(available(OPENCODE_RUNTIME_MODES)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "full-access",
    ]);
  });

  it("treats a provider that says nothing as able to run every mode", () => {
    expect(runtimeModeProblem(undefined, "auto")).toBeUndefined();
  });

  it("leaves Codex full access only while its sandbox cannot start", () => {
    expect(available(codexRuntimeModes(undefined))).toHaveLength(4);
    const broken = codexRuntimeModes("timed out connecting runner pipe-in");
    expect(available(broken)).toEqual(["full-access"]);
    expect(runtimeModeProblem(broken, "approval-required")).toContain(
      "timed out connecting runner pipe-in",
    );
  });
});

describe("codexSandboxProblemFrom", () => {
  it("finds no problem when the command ran inside the sandbox", () => {
    expect(codexSandboxProblemFrom({ code: 0, stdout: "sandbox-ok\r\n", stderr: "" })).toBe(
      undefined,
    );
  });

  it("reports the last line Codex said when the sandbox did not start", () => {
    expect(
      codexSandboxProblemFrom({
        code: 1,
        stdout: "",
        stderr: "starting\nError: timed out after 15000ms connecting runner pipe-in\n",
      }),
    ).toBe("Error: timed out after 15000ms connecting runner pipe-in");
  });

  it("does not take a clean exit without the word for a sandbox that works", () => {
    expect(codexSandboxProblemFrom({ code: 0, stdout: "", stderr: "" })).toBe(
      "codex sandbox ended with code 0",
    );
  });
});

describe("buildDeepSeekAcpSpawnInput", () => {
  it("sets the permission mode of dsh for full access and leaves it alone otherwise", () => {
    const base = { PATH: "x", DSH_PERMISSION_MODE: "read-only" };
    expect(buildDeepSeekAcpSpawnInput(null, "/work", base, true).env).toMatchObject({
      PATH: "x",
      DSH_PERMISSION_MODE: "danger-full-access",
    });
    expect(buildDeepSeekAcpSpawnInput(null, "/work", base, false).env).toBe(base);
    expect(buildDeepSeekAcpSpawnInput(null, "/work", base).env).toBe(base);
  });
});
