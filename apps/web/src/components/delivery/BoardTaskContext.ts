import type { EnvironmentId } from "@t3tools/contracts";
import { createContext, useContext } from "react";

import type { TaskView } from "../../lib/delivery";

/** The board task a view belongs to: its id and the board's own read of it. */
export interface BoardTask {
  readonly environmentId: EnvironmentId | null;
  readonly taskId: string;
  /** Null while the first read is out, or when there is no such task. */
  readonly task: TaskView | null;
}

/**
 * Provided where the board's task view mounts, so what it hosts reads the task from here and never
 * from the thread on screen, which is a seat's while one is open in the centre.
 */
export const BoardTaskContext = createContext<BoardTask | null>(null);

/** @public */
export const useBoardTask = () => useContext(BoardTaskContext);
