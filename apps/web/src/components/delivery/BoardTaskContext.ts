import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext } from "react";

import type { TaskView } from "../../lib/delivery";
import type { SeatConversations } from "./TaskTeamActivity";

/** The board task a view belongs to: its id and the board's own read of it. */
export interface BoardTask {
  readonly environmentId: EnvironmentId | null;
  readonly taskId: string;
  /** Null while the first read is out, or when there is no such task. */
  readonly task: TaskView | null;
  /** What is shown is the last reading, not a live one: it is old, or the engine did not answer. */
  readonly stale: boolean;
  /** Reads the task again, after something here changed it. */
  readonly refresh: () => void;
  /** Opens another board task in place of this one. */
  readonly openTask: (taskId: string) => void;
  /** Opens a conversation in the centre, the way a seat's opens. */
  readonly openThread: (thread: ScopedThreadRef) => void;
  /** The seats' own conversations, which the team's rows open. */
  readonly seats: SeatConversations;
}

/**
 * Provided where the board's task view mounts, so what it hosts reads the task from here and never
 * from the thread on screen, which is a seat's while one is open in the centre.
 */
export const BoardTaskContext = createContext<BoardTask | null>(null);

export const useBoardTask = () => useContext(BoardTaskContext);
