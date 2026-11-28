import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { TaskRelatedThreadRows } from "../chat/ThreadRelationshipsControl";
import { useBoardTask } from "./BoardTaskContext";

/**
 * The task's side chats and linked threads as the engine records them, so one made on another
 * environment is listed too. Each is the lineage's own row, opening at its own route.
 */
export function TaskRelatedThreads() {
  const gt = useGT();
  const board = useBoardTask();
  const task = board?.task;
  if (!task || task.relatedThreads.length === 0) return null;
  return (
    <ThreadDetailsSection
      headingId={`task-related-threads-${task.id}`}
      title={gt("Related threads", {
        $context: "thread details section: side chats and threads linked to a board task",
      })}
      data-task-related-threads
    >
      <TaskRelatedThreadRows
        threads={task.relatedThreads.map((link) => ({
          environmentId: EnvironmentId.make(link.environmentId),
          threadId: ThreadId.make(link.threadId),
          role: link.role,
        }))}
      />
    </ThreadDetailsSection>
  );
}
