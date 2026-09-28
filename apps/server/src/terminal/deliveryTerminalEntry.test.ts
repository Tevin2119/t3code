import { describe, expect, it } from "vite-plus/test";

import { withDeliveryTerminalEntry } from "./Manager.ts";

const raw = String.raw;
const candidates = [
  { shell: "pwsh.exe", args: ["-NoLogo"] },
  { shell: raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, args: ["-NoLogo"] },
  { shell: raw`C:\Windows\System32\cmd.exe` },
];
const env = { Path: raw`C:\Windows;C:\tools`, HOME: raw`C:\Users\dev` };
const script = raw`C:\work\it's here\scripts\t3-terminal\enter.ps1`;

describe("withDeliveryTerminalEntry", () => {
  it("leaves terminals as they are when no entry script is configured", () => {
    const result = withDeliveryTerminalEntry({
      candidates,
      env,
      platform: "win32",
      entryScript: null,
      team: "rnd",
    });
    expect(result).toEqual({ candidates, env });
  });

  it("dot-sources the script in PowerShell and puts its folder first on the path for cmd", () => {
    const result = withDeliveryTerminalEntry({
      candidates,
      env,
      platform: "win32",
      entryScript: script,
      team: undefined,
    });
    const command = raw`. 'C:\work\it''s here\scripts\t3-terminal\enter.ps1'`;
    expect(result.candidates[0]).toEqual({
      shell: "pwsh.exe",
      args: ["-NoLogo", "-NoExit", "-Command", command],
    });
    expect(result.candidates[1]?.args).toEqual(["-NoLogo", "-NoExit", "-Command", command]);
    expect(result.candidates[2]).toEqual({ shell: raw`C:\Windows\System32\cmd.exe` });
    expect(result.env.Path).toBe(raw`C:\work\it's here\scripts\t3-terminal;C:\Windows;C:\tools`);
    expect(result.env.PATH).toBeUndefined();
    expect(result.env.POLYMANIA_T3_TERMINAL).toBe("1");
    expect(result.env.POLYMANIA_DEFAULT_TEAM).toBeUndefined();
    expect(result.env.HOME).toBe(raw`C:\Users\dev`);
  });

  it("starts a bound thread's terminal on that thread's team", () => {
    const result = withDeliveryTerminalEntry({
      candidates,
      env,
      platform: "win32",
      entryScript: script,
      team: "rnd",
    });
    expect(result.candidates[0]?.args?.at(-1)).toBe(
      raw`. 'C:\work\it''s here\scripts\t3-terminal\enter.ps1' -Team 'rnd'`,
    );
    expect(result.env.POLYMANIA_DEFAULT_TEAM).toBe("rnd");
  });

  it("does not add the folder to the path twice", () => {
    const once = withDeliveryTerminalEntry({
      candidates,
      env,
      platform: "win32",
      entryScript: script,
      team: undefined,
    });
    const twice = withDeliveryTerminalEntry({
      candidates,
      env: once.env,
      platform: "win32",
      entryScript: script,
      team: undefined,
    });
    expect(twice.env.Path).toBe(once.env.Path);
  });
});
