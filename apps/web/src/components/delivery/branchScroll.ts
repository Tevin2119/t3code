const NEXT_PAGE_DISTANCE_PX = 96;

/** Whether a downward scroll has come close enough to the end to load the next page of branches. */
export function shouldLoadNextBranchPageAfterScroll(input: {
  readonly previousScrollTop: number | null;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): boolean {
  if (input.previousScrollTop === null || input.scrollTop <= input.previousScrollTop) {
    return false;
  }
  return input.scrollHeight - input.scrollTop - input.clientHeight <= NEXT_PAGE_DISTANCE_PX;
}
