import { describe, expect, it } from "vite-plus/test";

import { hermesTurnEndFrom } from "./HermesTurnEnd.ts";

describe("hermesTurnEndFrom", () => {
  it("takes a turn for ended well when its last message is the model's, with its reason for stopping", () => {
    expect(
      hermesTurnEndFrom({
        role: "assistant",
        finishReason: "stop",
        displayKind: undefined,
        content: "Done.",
      }),
    ).toEqual({ endedWell: true, why: undefined });
  });

  it("names a turn that Hermes marked as failed, whatever it wrote as its answer", () => {
    const end = hermesTurnEndFrom({
      role: "assistant",
      finishReason: undefined,
      displayKind: "failed_turn",
      content: "Your request was not processed.",
    });
    expect(end.endedWell).toBe(false);
    expect(end.why).toBe("Hermes reports that the turn failed: Your request was not processed.");
  });

  it("does not take a turn with no answer on record for one that ended well", () => {
    expect(
      hermesTurnEndFrom({
        role: "user",
        finishReason: undefined,
        displayKind: undefined,
        content: "x",
      }).endedWell,
    ).toBe(false);
  });

  it("does not take a record that cannot be read for a turn that ended well", () => {
    const end = hermesTurnEndFrom(undefined);
    expect(end.endedWell).toBe(false);
    expect(end.why).toContain("is not known to have ended well");
  });
});
