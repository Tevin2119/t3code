import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createSharedPoll } from "./deliveryPoll";

describe("createSharedPoll", () => {
  let visible = true;
  beforeEach(() => {
    visible = true;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads once per tick however many components poll the same reading", () => {
    const poll = createSharedPoll(() => visible);
    const refresh = vi.fn();
    const leave = Array.from({ length: 10 }, () => poll("lanes", 4_000, refresh));

    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(15);

    for (const stop of leave) stop();
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(15);
  });

  it("keeps the fastest pace while that component is mounted, then slows down", () => {
    const poll = createSharedPoll(() => visible);
    const refresh = vi.fn();
    const sidebar = poll("lanes", 15_000, refresh);
    const board = poll("lanes", 4_000, refresh);

    vi.advanceTimersByTime(12_000);
    expect(refresh).toHaveBeenCalledTimes(3);

    board();
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(5);
    sidebar();
  });

  it("keeps different readings on their own timers", () => {
    const poll = createSharedPoll(() => visible);
    const lanes = vi.fn();
    const task = vi.fn();
    const stops = [poll("lanes", 4_000, lanes), poll("task", 3_000, task)];

    vi.advanceTimersByTime(12_000);
    expect(lanes).toHaveBeenCalledTimes(3);
    expect(task).toHaveBeenCalledTimes(4);
    for (const stop of stops) stop();
  });

  it("reads nothing while the page is hidden and resumes when it is shown", () => {
    const poll = createSharedPoll(() => visible);
    const refresh = vi.fn();
    const stop = poll("lanes", 4_000, refresh);

    visible = false;
    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();

    visible = true;
    vi.advanceTimersByTime(4_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });
});
