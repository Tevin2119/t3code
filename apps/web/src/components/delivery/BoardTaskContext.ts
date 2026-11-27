import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext, type ReactNode } from "react";

import type { TaskView } from "../../lib/delivery";
import type { SeatThread, SeatThreadRow } from "../../lib/taskConversation";

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
  /** Opens one of the task's own tabs on the panel its view keeps them on. */
  readonly openTab: (tab: "task-evidence" | "task-deployments") => void;
  /** The engine's decisions on the task, which the Task item leads with. */
  readonly decisions: ReactNode;
  /** The task's own thread, whose lineage the seats' conversations open from. */
  readonly thread: ScopedThreadRef | null;
  readonly seats: {
    /** A seat's conversation, here or on a linked machine, when it has one. */
    readonly thread: (seat: string) => SeatThread | null;
    /** The seat conversations the thread's lineage adds, after the subagents it lists itself. */
    readonly rows: ReadonlyArray<SeatThreadRow>;
  };
}

/** Provided where the board's task view mounts, so what it hosts reads the task from here. */
export const BoardTaskContext = createContext<BoardTask | null>(null);

export const useBoardTask = () => useContext(BoardTaskContext);
