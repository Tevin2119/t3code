import { describe, expect, it } from "vite-plus/test";

import { kimiTurnEndFrom, lastKimiTurnEnded } from "./KimiTurnEnd.ts";

const ended = (over: Record<string, unknown>) =>
  JSON.stringify({ type: "turn.ended", agentId: "main", turnId: 0, ...over });

describe("lastKimiTurnEnded", () => {
  it("reads the last end of a turn, and no line that is only half written", () => {
    const record = [
      ended({ reason: "completed", turnId: 0 }),
      JSON.stringify({ type: "turn.prompt", text: 'it said "turn.ended" in passing' }),
      ended({ reason: "failed", turnId: 1, error: { code: "provider.api_error", message: "500" } }),
      '{"type":"turn.ended","agentId":"main","turnId":2,"reas',
    ].join("\n");
    expect(lastKimiTurnEnded(record)?.["turnId"]).toBe(1);
  });

  it("finds nothing in a record that holds no end of a turn", () => {
    expect(lastKimiTurnEnded('{"type":"turn.prompt"}\n')).toBe(undefined);
  });
});

describe("kimiTurnEndFrom", () => {
  it("takes a turn for ended well only when Kimi recorded it as completed", () => {
    expect(kimiTurnEndFrom({ type: "turn.ended", reason: "completed" }, "f").endedWell).toBe(true);
  });

  it("names the error of a turn that failed", () => {
    const end = kimiTurnEndFrom(
      {
        type: "turn.ended",
        reason: "failed",
        error: { code: "provider.connection_error", message: "terminated", retryable: true },
      },
      "f",
    );
    expect(end.endedWell).toBe(false);
    expect(end.why).toBe(
      "Kimi reports that the turn failed: provider.connection_error: terminated",
    );
  });

  it("names a turn that was stopped at its limit of steps", () => {
    const end = kimiTurnEndFrom(
      { type: "turn.ended", reason: "failed", interruptReason: "max_steps" },
      "f",
    );
    expect(end.why).toBe("Kimi reports that the turn failed: max_steps");
  });

  it("does not take a record that cannot be read for a turn that ended well", () => {
    const end = kimiTurnEndFrom(undefined, undefined);
    expect(end.endedWell).toBe(false);
    expect(end.why).toContain("is not known to have ended well");
  });
});
