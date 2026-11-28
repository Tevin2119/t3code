// The engine's board task threads are made under this prefix (`boardThreadMarker.ts`).
const BOARD_TASK_THREAD_PREFIX = "board-task:";

/**
 * Whether "File a task from this thread" is offered: delivery is on in the thread's environment,
 * the thread is not a board task's own, and this connection may file. Every entry point asks this.
 */
export function fileThreadTaskOffered(input: {
  readonly deliveryEnabled: boolean;
  readonly threadId: string;
  readonly permitted: boolean;
}): boolean {
  return (
    input.deliveryEnabled && input.permitted && !input.threadId.startsWith(BOARD_TASK_THREAD_PREFIX)
  );
}
