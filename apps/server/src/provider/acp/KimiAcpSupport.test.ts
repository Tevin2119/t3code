import { expect, it } from "@effect/vitest";

import { kimiLoginArgs, parseKimiLoginChallenge } from "./KimiAcpSupport.ts";

// Captured verbatim from `kimi login --region global` stderr on CLI 0.42.0.
const LOGIN_OUTPUT = `
Opening browser for Kimi device login: https://www.kimi.ai/code/authorize_device?user_code=WI1G-KMXJ
If the browser did not open, paste the URL above and enter code: WI1G-KMXJ
Code expires in 1800s.
Waiting for authorization to complete…
`;

it("reads the verification link and device code the CLI prints", () => {
  expect(parseKimiLoginChallenge(LOGIN_OUTPUT)).toEqual({
    verificationUrl: "https://www.kimi.ai/code/authorize_device?user_code=WI1G-KMXJ",
    verificationCode: "WI1G-KMXJ",
  });
});

it("reads the code from the prompt line when the link omits it", () => {
  const challenge = parseKimiLoginChallenge(
    "Visit https://kimi.com/code/authorize_device and enter code: AB12-CD34",
  );

  expect(challenge?.verificationUrl).toBe("https://kimi.com/code/authorize_device");
  expect(challenge?.verificationCode).toBe("AB12-CD34");
});

it("waits for a link rather than reporting a half-read challenge", () => {
  expect(parseKimiLoginChallenge("Opening browser for Kimi device login:")).toBeUndefined();
});

it("targets the configured region so the CLI does not prompt for one", () => {
  expect(kimiLoginArgs("mainland-cn")).toEqual(["login", "--region", "mainland-cn"]);
});
