import { describe, expect, it } from "vite-plus/test";

import {
  isDefaultThreadDetailsVisibility,
  resolveThreadDetailsVisibility,
  RESET_THREAD_DETAILS_ITEMS,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";

const usage = THREAD_DETAILS_ITEMS.find((item) => item.id === "usage")!;
const servers = THREAD_DETAILS_ITEMS.find((item) => item.id === "servers")!;
const task = THREAD_DETAILS_ITEMS.find((item) => item.id === "task")!;

describe("thread details items", () => {
  it.each([
    { legacy: false, items: {}, usage: false, context: false },
    { legacy: true, items: {}, usage: true, context: true },
    { legacy: true, items: { usage: false }, usage: false, context: true },
    { legacy: false, items: { usage: true, retired: false }, usage: true, context: false },
  ])("resolves Usage and Context from overrides and the retired Labs flag: %o", (row) => {
    const visibility = resolveThreadDetailsVisibility({
      threadDetailsItems: row.items,
      threadDetailsUsageEnabled: row.legacy,
    });
    expect(visibility.usage).toBe(row.usage);
    expect(visibility.context).toBe(row.context);
    expect(visibility.servers).toBe(true);
  });

  it("stores only choices that differ from the default", () => {
    const legacyOn = { threadDetailsItems: {}, threadDetailsUsageEnabled: true };
    expect(setThreadDetailsItem(legacyOn, usage, false)).toEqual({ usage: false });
    expect(setThreadDetailsItem(legacyOn, usage, true)).toEqual({});

    const hidden = { threadDetailsItems: { servers: false }, threadDetailsUsageEnabled: false };
    expect(setThreadDetailsItem(hidden, servers, true)).toEqual({});
  });

  it("shows the Task item by default, keeps it off once switched off, and resets it to on", () => {
    const fresh = { threadDetailsItems: {}, threadDetailsUsageEnabled: false };
    expect(resolveThreadDetailsVisibility(fresh).task).toBe(true);
    expect(isDefaultThreadDetailsVisibility(resolveThreadDetailsVisibility(fresh))).toBe(true);

    const off = setThreadDetailsItem(fresh, task, false);
    expect(off).toEqual({ task: false });
    const switchedOff = { threadDetailsItems: off, threadDetailsUsageEnabled: false };
    expect(resolveThreadDetailsVisibility(switchedOff).task).toBe(false);
    expect(isDefaultThreadDetailsVisibility(resolveThreadDetailsVisibility(switchedOff))).toBe(
      false,
    );
    expect(setThreadDetailsItem(switchedOff, task, true)).toEqual({});

    expect(resolveThreadDetailsVisibility(RESET_THREAD_DETAILS_ITEMS).task).toBe(true);
  });
});
