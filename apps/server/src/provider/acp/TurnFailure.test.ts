import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { turnFailed, turnFailureMessage } from "./TurnFailure.ts";

describe("turnFailureMessage", () => {
  it("takes the words of a failure", () => {
    expect(turnFailureMessage(Cause.fail(new Error("the provider refused")), "DeepSeek")).toBe(
      "the provider refused",
    );
  });

  it("takes the words of an error that reached the adapter as a defect", () => {
    expect(
      turnFailureMessage(
        Cause.die({ code: -32603, message: "Internal error: turn failed" }),
        "DeepSeek",
      ),
    ).toBe("Internal error: turn failed");
    expect(turnFailureMessage(Cause.die("the stream was cut"), "Kimi")).toBe("the stream was cut");
  });

  it("says that no reason was given when none was", () => {
    expect(turnFailureMessage(Cause.die({ code: 1 }), "Hermes")).toBe(
      "Hermes ended the turn with an error it did not name.",
    );
    expect(turnFailureMessage(Cause.fail(new Error("  ")), "Hermes")).toBe(
      "Hermes ended the turn with an error it did not name.",
    );
  });
});

describe("turnFailed", () => {
  it("counts a failure and a defect, and not a turn that was stopped", () => {
    expect(turnFailed(Cause.fail("x"))).toBe(true);
    expect(turnFailed(Cause.die("x"))).toBe(true);
    expect(turnFailed(Cause.interrupt())).toBe(false);
  });
});
