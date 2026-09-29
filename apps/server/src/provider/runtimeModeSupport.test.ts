import { describe, expect, it } from "vite-plus/test";

import { buildDeepSeekAcpSpawnInput, deepseekPermissionModeFor } from "./acp/DeepSeekAcpSupport.ts";
import { codexSandboxProblemFrom } from "./Layers/codexSandboxCheck.ts";
import {
  CLAUDE_RUNTIME_MODES,
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
        if (!item.available) expect(item.note).toBeUndefined();
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

  it("offers Kimi and the DeepSeek harness the two modes they can honour", () => {
    for (const support of [KIMI_RUNTIME_MODES, DEEPSEEK_RUNTIME_MODES]) {
      expect(available(support)).toEqual(["approval-required", "full-access"]);
    }
  });

  it("offers Hermes full access only, since it runs commands without asking", () => {
    expect(available(HERMES_RUNTIME_MODES)).toEqual(["full-access"]);
    expect(runtimeModeProblem(HERMES_RUNTIME_MODES, "approval-required")).toContain(
      "runs shell commands without asking",
    );
  });

  it("offers OpenCode everything but a reviewer it does not have", () => {
    expect(available(OPENCODE_RUNTIME_MODES)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "full-access",
    ]);
  });

  it("offers Claude every mode, and says of Auto what was seen of it", () => {
    expect(available(CLAUDE_RUNTIME_MODES)).toHaveLength(4);
    const auto = CLAUDE_RUNTIME_MODES.find((item) => item.mode === "auto");
    expect(auto?.available).toBe(true);
    expect(auto?.note).toContain("was not seen to stop anything");
    expect(runtimeModeProblem(CLAUDE_RUNTIME_MODES, "auto")).toBeUndefined();
  });

  it("treats a provider that says nothing as able to run every mode", () => {
    expect(runtimeModeProblem(undefined, "auto")).toBeUndefined();
  });

  it("leaves Codex full access only while its sandbox cannot start", () => {
    expect(available(codexRuntimeModes(undefined))).toHaveLength(4);
    // With its sandbox working, what was seen of the modes that ask less is said beside them.
    const noteOf = (mode: string) =>
      codexRuntimeModes(undefined).find((item) => item.mode === mode)?.note;
    expect(noteOf("auto")).toContain("was not seen to stop anything");
    expect(noteOf("auto-accept-edits")).toContain("refused by the sandbox");
    expect(noteOf("approval-required")).toBeUndefined();
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
    ).toBe(
      "Error: timed out after 15000ms connecting runner pipe-in. The runner of the sandbox did not start: this is what is seen when T3 Code runs in a background or service session. Start T3 Code in the signed-in session, or use Full access",
    );
  });

  it("does not take a clean exit without the word for a sandbox that works", () => {
    expect(codexSandboxProblemFrom({ code: 0, stdout: "", stderr: "" })).toBe(
      "codex sandbox ended with code 0. Put the sandbox right in Codex, or use Full access",
    );
  });
});

describe("buildDeepSeekAcpSpawnInput", () => {
  it("starts dsh in the permission mode that honours the access mode of the thread", () => {
    expect(deepseekPermissionModeFor("full-access")).toBe("danger-full-access");
    // In its default mode dsh writes inside the workspace without asking.
    expect(deepseekPermissionModeFor("approval-required")).toBe("read-only");
    expect(deepseekPermissionModeFor("auto-accept-edits")).toBeUndefined();

    const base = { PATH: "x", DSH_PERMISSION_MODE: "workspace-write" };
    expect(buildDeepSeekAcpSpawnInput(null, "/work", base, "read-only").env).toMatchObject({
      PATH: "x",
      DSH_PERMISSION_MODE: "read-only",
    });
    expect(buildDeepSeekAcpSpawnInput(null, "/work", base).env).toBe(base);
  });
});
