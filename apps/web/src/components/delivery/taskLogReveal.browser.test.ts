import { afterEach, expect, it, vi } from "vite-plus/test";

import { revealPendingTaskLog, showTaskLog } from "./taskLogReveal";

const column = () => {
  const panel = document.createElement("div");
  panel.dataset.boardPanel = "";
  const log = document.createElement("div");
  log.dataset.taskSection = "log";
  log.scrollIntoView = vi.fn();
  panel.append(log);
  document.body.append(panel);
  return { panel, log };
};

afterEach(() => {
  document.body.replaceChildren();
});

it("scrolls to the log at once where the column is shown", () => {
  const { log } = column();
  showTaskLog({ sheetOpening: false });
  expect(log.scrollIntoView).toHaveBeenCalledOnce();
  revealPendingTaskLog();
  expect(log.scrollIntoView).toHaveBeenCalledOnce();
});

it("waits for the phone's sheet to open, then scrolls to the log once", () => {
  const { log } = column();
  showTaskLog({ sheetOpening: true });
  expect(log.scrollIntoView).not.toHaveBeenCalled();
  revealPendingTaskLog();
  expect(log.scrollIntoView).toHaveBeenCalledOnce();
  revealPendingTaskLog();
  expect(log.scrollIntoView).toHaveBeenCalledOnce();
});
