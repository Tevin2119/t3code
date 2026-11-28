interface SharedPoll {
  refresh: () => void;
  readonly wants: Array<number>;
  everyMs: number;
  timer: ReturnType<typeof setInterval> | null;
}

/**
 * One timer for each read, however many mounted components poll it: the fastest of them sets
 * the pace, and nothing is read while the page is hidden.
 */
export function createSharedPoll(visible: () => boolean) {
  const polls = new Map<unknown, SharedPoll>();

  const schedule = (poll: SharedPoll) => {
    const everyMs = Math.min(...poll.wants);
    if (poll.timer !== null && everyMs === poll.everyMs) return;
    if (poll.timer !== null) clearInterval(poll.timer);
    poll.everyMs = everyMs;
    poll.timer = setInterval(() => {
      if (visible()) poll.refresh();
    }, everyMs);
  };

  return (key: unknown, everyMs: number, refresh: () => void): (() => void) => {
    let poll = polls.get(key);
    if (poll === undefined) {
      poll = { refresh, wants: [], everyMs, timer: null };
      polls.set(key, poll);
    }
    poll.refresh = refresh;
    poll.wants.push(everyMs);
    schedule(poll);
    const joined = poll;
    return () => {
      joined.wants.splice(joined.wants.indexOf(everyMs), 1);
      if (joined.wants.length > 0) return schedule(joined);
      if (joined.timer !== null) clearInterval(joined.timer);
      if (polls.get(key) === joined) polls.delete(key);
    };
  };
}

export const pollDeliveryRead = createSharedPoll(
  () => typeof document === "undefined" || document.visibilityState === "visible",
);
