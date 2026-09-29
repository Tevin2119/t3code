import { describe, expect, it } from "vite-plus/test";

import { cleanArguments, cleanSettings, passedPayload } from "./passedRecord.ts";

describe("cleanArguments", () => {
  it("keeps what a harness was started with, and leaves out what is secret", () => {
    expect(
      cleanArguments([
        "app-server",
        "-c",
        'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
        "--api-key",
        "sk-not-a-real-key",
        "-m",
        "gpt-6-astra",
      ]),
    ).toEqual([
      "app-server",
      "-c",
      "mcp_servers.t3-code.bearer_token_env_var=<kept out>",
      "--api-key",
      "<kept out>",
      "-m",
      "gpt-6-astra",
    ]);
  });

  it("says how long the instructions are, and not what they say", () => {
    const words = cleanArguments(["-c", `developer_instructions=${"x".repeat(900)}`]);
    expect(words[1]).toBe("developer_instructions=<900 characters>");
  });
});

describe("cleanSettings", () => {
  it("leaves out the value of a setting whose name speaks of a secret", () => {
    expect(
      cleanSettings({
        DSH_PERMISSION_MODE: "read-only",
        DEEPSEEK_API_KEY: "abc",
        effort: undefined,
      }),
    ).toEqual({ DSH_PERMISSION_MODE: "read-only", DEEPSEEK_API_KEY: "<kept out>" });
  });
});

describe("passedPayload", () => {
  it("names only what was handed over", () => {
    expect(passedPayload({ when: "turn", model: "gpt-6-astra", reasoning: "high" })).toEqual({
      config: { passed: { when: "turn", model: "gpt-6-astra", reasoning: "high" } },
    });
  });
});
