import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { DeliveryBoardApprovalKeyStatus, DeliverySetBoardApprovalKeyInput } from "./delivery.ts";

const decodeSet = Schema.decodeSync(DeliverySetBoardApprovalKeyInput);
const decodeSetExit = Schema.decodeUnknownExit(DeliverySetBoardApprovalKeyInput);
const decodeStatus = Schema.decodeUnknownSync(DeliveryBoardApprovalKeyStatus);
const decodeStatusExit = Schema.decodeUnknownExit(DeliveryBoardApprovalKeyStatus);

describe("board approval key", () => {
  it("takes a key to save as typed, or null to clear it", () => {
    expect(decodeSet({ key: " pass " })).toEqual({ key: " pass " });
    expect(decodeSet({ key: null })).toEqual({ key: null });
  });

  it("refuses an empty, overlong or missing key", () => {
    expect(decodeSetExit({ key: "" })._tag).toBe("Failure");
    expect(decodeSetExit({ key: "k".repeat(1_025) })._tag).toBe("Failure");
    expect(decodeSetExit({})._tag).toBe("Failure");
  });

  it("reports where the key comes from and never carries it", () => {
    for (const source of ["environment", "settings", "none"]) {
      expect(decodeStatusExit({ source })._tag).toBe("Success");
    }
    expect(decodeStatusExit({ source: "elsewhere" })._tag).toBe("Failure");
    expect(decodeStatus({ source: "settings", key: "x" })).toEqual({ source: "settings" });
  });
});
