import { describe, expect, it } from "vite-plus/test";

import { isPlanModelProvider, PLAN_COST_LABEL, planCostNote, planMakerOf } from "./usagePlans.ts";

const usd = (value: number) => `$${value.toFixed(2)}`;

describe("coding plans", () => {
  it("names the maker behind a plan, and nothing for a provider that is not one", () => {
    expect(planMakerOf("zai-coding-plan")).toBe("zai");
    expect(planMakerOf("kimi-code")).toBe("moonshot");
    expect(planMakerOf("zai")).toBeNull();
    expect(planMakerOf(null)).toBeNull();
    expect(isPlanModelProvider("Kimi-Code")).toBe(true);
    expect(isPlanModelProvider("openrouter")).toBe(false);
  });

  it("labels a cost all, part or none of which came through a plan", () => {
    expect(planCostNote(10, 10, usd)).toBe(PLAN_COST_LABEL);
    expect(planCostNote(10, 10 + 1e-12, usd)).toBe(PLAN_COST_LABEL);
    expect(planCostNote(10, 4, usd)).toBe(`$4.00 ${PLAN_COST_LABEL}`);
    expect(planCostNote(10, 0, usd)).toBeNull();
  });
});
