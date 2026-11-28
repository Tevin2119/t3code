const LOG = '[data-board-panel] [data-task-section="log"]';

// Asked for while the phone's sidebar sheet is still opening: done once it has opened.
let pending = false;

function scrollToLog() {
  const log = document.querySelector(LOG);
  if (!log) return false;
  log.scrollIntoView({ block: "start", behavior: "smooth" });
  return true;
}

/** Scrolls the board's column to the open task's engine log, now or once its sheet has opened. */
export function showTaskLog(options: { readonly sheetOpening: boolean }) {
  pending = options.sheetOpening || !scrollToLog();
}

/** The column's sheet has opened: a log asked for meanwhile is scrolled to now. */
export function revealPendingTaskLog() {
  if (pending && scrollToLog()) pending = false;
}
