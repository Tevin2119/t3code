import type {
  EnvironmentId,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "../chat/providerIconUtils";
import { OrchestratorLineup } from "./OrchestratorLineup";
import { TeamBadge } from "./TeamBadge";

/**
 * Where an empty board-task thread would ask for a first message: its team and lead, then its
 * seats, as the composer's team badge and Orchestrator panel show them. The board sets them, so
 * nothing here changes them.
 */
export function TaskTeamHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly driver: ProviderDriverKind | null;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly models: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly leadModelSelection: ModelSelection | null;
}) {
  return (
    <section
      className="flex w-full max-w-xl flex-col rounded-xl border border-border bg-card"
      data-task-team-header
    >
      <div className="flex min-w-0 items-center px-2 pt-2">
        <TeamBadge environmentId={props.environmentId} threadId={props.threadId} boardOwned />
      </div>
      <OrchestratorLineup
        environmentId={props.environmentId}
        threadId={props.threadId}
        driver={props.driver}
        entries={props.entries}
        models={props.models}
        boardOwned
        leadModelSelection={props.leadModelSelection}
      />
    </section>
  );
}
