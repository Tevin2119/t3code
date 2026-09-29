import { describe, expect, it } from "vite-plus/test";

import { buildPiRpcArgs } from "./PiAdapter.ts";

describe("buildPiRpcArgs", () => {
  it("passes the chosen reasoning level to pi, before what the team adds", () => {
    expect(
      buildPiRpcArgs({
        provider: "openai-codex",
        model: "openai-codex/gpt-6-luna",
        thinking: "high",
        teamArgs: ["--append-system-prompt", "instructions.md"],
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--provider",
      "openai-codex",
      "--model",
      "openai-codex/gpt-6-luna",
      "--thinking",
      "high",
      "--append-system-prompt",
      "instructions.md",
    ]);
  });

  it("leaves the level to pi when none is given", () => {
    expect(buildPiRpcArgs({ provider: "kimi-coding", model: undefined })).toEqual([
      "--mode",
      "rpc",
      "--provider",
      "kimi-coding",
    ]);
  });
});
