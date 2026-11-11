import {
  DELIVERY_HARNESS_BY_DRIVER,
  type DeliveryOrchestrationConfig,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { type DeliveryTeam, selectableTeams } from "../../lib/delivery";
import { resolveOrchestratorRoster } from "../../lib/orchestratorChat";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { deliveryEnvironment, useDeliveryRead } from "../../state/delivery";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ModelEsque } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { NO_TEAM } from "./OrchestratorChatSetup";
import { type OrchestratorLineupValue, OrchestratorParticipants } from "./OrchestratorParticipants";

/** What is in force for a conversation, in the shape a person edits. */
function valueOfLineup(
  lineup: DeliveryOrchestrationConfig | undefined,
  team: DeliveryTeam | null,
): OrchestratorLineupValue {
  if (!lineup) return {};
  const seats = new Set(team?.seats.map((seat) => seat.seat));
  return {
    participantChoices: Object.fromEntries(
      (team?.seats ?? []).map((seat) => {
        const joined = lineup.participants.find((item) => item.seat === seat.seat);
        return [
          seat.seat,
          joined ? { included: true, modelSelection: joined.modelSelection } : { included: false },
        ];
      }),
    ),
    extraParticipants: lineup.participants
      .filter((item) => !seats.has(item.seat))
      .map((item) => ({ id: item.seat, role: item.role, modelSelection: item.modelSelection })),
    ...(lineup.critique ? { critique: lineup.critique } : {}),
    ...(lineup.access ? { access: lineup.access } : {}),
  };
}

/** Changes who joins a conversation that has already started, from its next message on. */
export function OrchestratorLineup(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly driver: ProviderDriverKind | null;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly models: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
}) {
  const { threadId } = props;
  const state = useEnvironmentQuery(
    deliveryEnvironment.threadBinding({
      environmentId: props.environmentId,
      input: { threadId },
    }),
  );
  const setLineup = useAtomCommand(deliveryEnvironment.setThreadLineup, {
    label: "change participants",
    reportFailure: false,
  });
  const read = useDeliveryRead(props.environmentId, "/api/teams");
  const teams = selectableTeams(read.body);
  // Unsaved changes; absent, the panel shows what is in force.
  const [edit, setEdit] = useState<{
    readonly team?: string | null;
    readonly value?: OrchestratorLineupValue;
  }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const binding = state.data?.binding ?? null;
  const lineup = state.data?.lineup;
  const teamName = binding?.team ?? (edit.team !== undefined ? edit.team : (lineup?.team ?? null));
  const team = teams.find((item) => item.team === teamName) ?? null;
  const value = edit.value ?? valueOfLineup(lineup, team);
  const roster = resolveOrchestratorRoster({
    team,
    teamless: team === null,
    // A conversation bound to no team names the one its participants take their roles from.
    ...(binding === null && team ? { callsTeam: team.team } : {}),
    choices: value.participantChoices,
    entries: props.entries,
    critique: value.critique,
    access: value.access,
    extras: value.extraParticipants,
    orchestrator: {
      harness:
        binding?.harness ??
        (props.driver ? (DELIVERY_HARNESS_BY_DRIVER[props.driver] ?? null) : null),
      role: binding?.role ?? null,
    },
  });
  const changed = edit.team !== undefined || edit.value !== undefined;

  const apply = async (orchestration: DeliveryOrchestrationConfig | null) => {
    setSaving(true);
    setFailure(null);
    const result = await setLineup({
      environmentId: props.environmentId,
      input: { threadId, orchestration },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      setFailure("The participants could not be changed. Try again.");
      return;
    }
    setEdit({});
    state.refresh();
  };

  if (state.data === null) {
    return (
      <p role="status" className="p-3 text-xs text-muted-foreground">
        {state.error ?? "Loading this conversation's participants…"}
      </p>
    );
  }

  return (
    <div className="flex max-h-96 flex-col gap-3 overflow-y-auto p-3" data-orchestrator-lineup>
      <span className="text-sm font-medium">Orchestrator</span>
      <p className="text-xs text-muted-foreground">
        {lineup
          ? "Change who joins this conversation. It takes effect from your next message."
          : "Bring participants into this conversation. From your next message they contribute first and this chat's model brings the results together."}
      </p>
      {binding ? (
        <p className="text-xs text-muted-foreground">
          Team {binding.team}. A conversation keeps the team it started with.
        </p>
      ) : (
        <Select
          value={team?.team ?? NO_TEAM}
          onValueChange={(next) => {
            if (typeof next !== "string" || !next) return;
            // Another team's seats are another lineup; added participants come along.
            setEdit({
              team: next === NO_TEAM ? null : next,
              value: value.extraParticipants ? { extraParticipants: value.extraParticipants } : {},
            });
          }}
        >
          <SelectTrigger aria-label="Team to bring in">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={NO_TEAM}>No team: choose your own participants</SelectItem>
            {teams.map((item) => (
              <SelectItem key={item.team} value={item.team}>
                {item.team}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
      {read.error ? (
        <p role="alert" className="text-xs text-warning">
          {read.error}
        </p>
      ) : null}
      <OrchestratorParticipants
        environmentId={props.environmentId}
        team={team}
        value={value}
        onChange={(patch) => setEdit({ ...edit, value: { ...value, ...patch } })}
        roster={roster}
        entries={props.entries}
        models={props.models}
      />
      {failure ? (
        <p role="alert" className="text-xs text-warning">
          {failure}
        </p>
      ) : null}
      <Button
        size="sm"
        disabled={saving || !changed || roster.configuration === null}
        onClick={() => {
          if (roster.configuration) void apply(roster.configuration);
        }}
      >
        Use from the next message
      </Button>
      {changed ? (
        <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEdit({})}>
          Discard changes
        </Button>
      ) : null}
      {lineup ? (
        <Button size="sm" variant="ghost" disabled={saving} onClick={() => void apply(null)}>
          Use ordinary chat
        </Button>
      ) : null}
    </div>
  );
}
