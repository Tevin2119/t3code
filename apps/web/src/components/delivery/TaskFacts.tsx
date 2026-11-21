import type { EnvironmentId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";

import { BOARD_LANE, boardLaneOf, boardLaneTitle } from "../../lib/boardLanes";
import { reworkOf, WORK_STAGE_TITLE, workStageOf } from "../../lib/boardLaneCards";
import type { TaskView } from "../../lib/delivery";
import { LANE_TITLE } from "../../lib/deliveryBoard";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { ReworkCount, WaitKinds } from "./BoardLaneCards";
import { MergePermissionSummary } from "./MergePermissionControls";
import { Row, PublicationRows } from "./taskParts";
import { DeploymentSnapshotStale, TaskDeploymentBadge } from "./TaskDeploymentStatus";
import { TaskTeamActivity, type SeatConversations } from "./TaskTeamActivity";

/**
 * The task's engine facts at the head of the right panel (BOARD-REVAMP-UI-SPEC section 6). Every
 * line is a field the engine sent, never a summary of what the lead said, and none offers a step:
 * those come from the task's own actions.
 */
export function TaskFacts(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: TaskView;
  readonly stale: boolean;
  readonly conversations: SeatConversations;
}) {
  const gt = useGT();
  const m = useMessages();
  const { task } = props;
  const { card } = task;
  const lane = boardLaneOf(task.lane ?? "");
  const rework = reworkOf(card);
  const showsPublication = task.publications.length > 0 || task.state === "approved";
  return (
    <div className="flex shrink-0 flex-col border-b" data-task-facts>
      <TaskTeamActivity
        environmentId={props.environmentId}
        task={task}
        conversations={props.conversations}
      />
      <ThreadDetailsSection
        headingId={`task-facts-${task.id}`}
        title={gt("Where it stands")}
        data-task-facts-standing
      >
        <div className="flex flex-col gap-2 px-2.5">
          <Row label={gt("Stage")}>
            <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
              <span data-task-facts-lane={lane}>
                {boardLaneTitle(lane, m, LANE_TITLE[lane] ?? task.state)}
                {lane === BOARD_LANE.inWork ? `, ${m(WORK_STAGE_TITLE[workStageOf(card)])}` : ""}
                {task.held ? `, ${gt("paused")}` : ""}
              </span>
              {rework ? <ReworkCount rounds={rework.rounds} /> : null}
            </span>
          </Row>
          <WaitKinds card={card} />
          {showsPublication ? <PublicationRows task={task} /> : null}
          <MergePermissionSummary policy={card.mergePermission} />
          <DeploymentSnapshotStale value={props.stale}>
            <TaskDeploymentBadge card={card} />
          </DeploymentSnapshotStale>
        </div>
      </ThreadDetailsSection>
    </div>
  );
}
