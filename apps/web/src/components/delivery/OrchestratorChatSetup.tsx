import {
  DELIVERY_HARNESS_BY_DRIVER,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { resolveTeamChoice, rolesForHarness, selectableTeams } from "../../lib/delivery";
import { resolveOrchestratorRoster } from "../../lib/orchestratorChat";
import type { ProviderInstanceEntry } from "../../providerInstances";

import {
  useBoardStore,
  useDeliveryDraftStore,
  useDeliveryRead,
  useDraftTeamChoice,
  useOrchestratorDraft,
  useOrchestratorDraftStore,
} from "../../state/delivery";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import type { ModelEsque } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { OrchestratorParticipants } from "./OrchestratorParticipants";

/** The team select's value for a conversation with no team behind it. */
export const NO_TEAM = "\u0000none";

export function OrchestratorChatSetup(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly lead: ModelSelection;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly models: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly onLeadChange: (instanceId: ProviderInstanceId, model: string) => void;
  readonly getLeadDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  readonly onExit: () => void;
}) {
  const draft = useOrchestratorDraft(props.threadId);
  const choice = useDraftTeamChoice(props.threadId, props.environmentId);
  const update = useOrchestratorDraftStore((state) => state.update);
  const chooseTeam = useOrchestratorDraftStore((state) => state.chooseTeam);
  const chooseLead = useDeliveryDraftStore((state) => state.chooseTeam);
  const read = useDeliveryRead(props.environmentId, "/api/teams");
  const navigate = useNavigate();
  const setDeliveryEnvironment = useBoardStore((state) => state.setDeliveryEnvironment);
  const openProfile = (search: { name: string } | { new: true; from?: string }) => {
    setDeliveryEnvironment(props.environmentId);
    void navigate({ to: "/profiles", search });
  };
  const teams = selectableTeams(read.body);
  const teamless = draft?.teamless === true;
  const team = teamless ? null : (teams.find((item) => item.team === draft?.team) ?? null);
  const entries = props.entries.filter((entry) => DELIVERY_HARNESS_BY_DRIVER[entry.driverKind]);
  const leadEntry = entries.find((entry) => entry.instanceId === props.lead.instanceId);
  const resolved = resolveTeamChoice({
    teams,
    team: team?.team ?? null,
    role: choice.role,
    driver: leadEntry?.driverKind ?? null,
  });
  const roster = resolveOrchestratorRoster({
    team,
    teamless,
    choices: draft?.participantChoices,
    entries: props.entries,
    critique: draft?.critique,
    access: draft?.access,
    extras: draft?.extraParticipants,
    orchestrator: {
      harness: leadEntry ? (DELIVERY_HARNESS_BY_DRIVER[leadEntry.driverKind] ?? null) : null,
      role: resolved.state === "ready" ? resolved.role : null,
    },
  });
  // The role is only a question when the orchestrator's provider holds no one seat in the team.
  const heldRole =
    team && leadEntry
      ? rolesForHarness(team, DELIVERY_HARNESS_BY_DRIVER[leadEntry.driverKind] ?? "").held
      : null;
  const roleTitle = (role: string) => team?.roles.find((item) => item.role === role)?.title ?? role;
  const models = new Map(props.models);
  const leadOptions = models.get(props.lead.instanceId) ?? [];
  if (!leadOptions.some((model) => model.slug === props.lead.model)) {
    models.set(props.lead.instanceId, [
      ...leadOptions,
      { slug: props.lead.model, name: props.lead.model },
    ]);
  }
  if (!draft) return null;

  return (
    <div className="flex max-h-96 flex-col gap-3 overflow-y-auto p-3" data-orchestrator-chat-setup>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Orchestrator</span>
        <ProviderModelPicker
          environmentId={props.environmentId}
          activeInstanceId={props.lead.instanceId}
          model={props.lead.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={models}
          onInstanceModelChange={props.onLeadChange}
          getModelDisabledReason={props.getLeadDisabledReason}
          triggerAriaLabel="Choose orchestrator provider and model"
          isComposerOwned={false}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Participants contribute independently, discuss each other's findings, then the orchestrator
        brings the results together.
      </p>
      {read.error ? (
        <p role="alert" className="text-xs text-warning">
          {read.error}
        </p>
      ) : null}
      {!read.error && read.body === null ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading teams…
        </p>
      ) : null}
      <Select
        value={teamless ? NO_TEAM : (team?.team ?? "")}
        onValueChange={(value) => {
          if (typeof value !== "string" || !value) return;
          if (value === NO_TEAM) {
            update(props.threadId, { teamless: true, participantChoices: {} });
            chooseLead(props.threadId, props.environmentId, { team: null, role: null });
            return;
          }
          update(props.threadId, { teamless: false });
          chooseTeam(props.threadId, props.environmentId, value);
          chooseLead(props.threadId, props.environmentId, { team: value, role: null });
        }}
      >
        <SelectTrigger aria-label="Orchestrator team">
          <SelectValue placeholder="Choose a team" />
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
      <div className="flex items-center gap-1">
        {team ? (
          <Button size="xs" variant="ghost" onClick={() => openProfile({ name: team.team })}>
            Edit team
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => openProfile({ new: true, ...(team ? { from: team.team } : {}) })}
        >
          New team
        </Button>
      </div>
      {teamless ? (
        <p className="text-xs text-muted-foreground">
          Add two or more participants. They join as themselves, with no team instructions, and
          nothing is saved.
        </p>
      ) : null}
      {team && heldRole === null ? (
        <div className="flex flex-col gap-1">
          <Select
            value={resolved.state === "ready" ? resolved.role : ""}
            onValueChange={(value) => {
              if (typeof value === "string")
                chooseLead(props.threadId, props.environmentId, { team: team.team, role: value });
            }}
          >
            <SelectTrigger aria-label="Orchestrator role">
              <SelectValue placeholder="Choose the orchestrator's role" />
            </SelectTrigger>
            <SelectPopup>
              {team.roles.map((role) => (
                <SelectItem key={role.role} value={role.role}>
                  {role.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <p className="text-xs text-muted-foreground">
            {leadEntry?.displayName ?? "This provider"} holds no single seat in this team, so choose
            which role's instructions the orchestrator follows.
          </p>
        </div>
      ) : null}
      {team && heldRole !== null && resolved.state === "ready" ? (
        <p className="text-xs text-muted-foreground">
          The orchestrator follows the team's {roleTitle(resolved.role)} instructions.
        </p>
      ) : null}
      {resolved.state === "blocked" && !teamless ? (
        <p role="alert" className="text-xs text-warning">
          {resolved.why}
        </p>
      ) : null}
      <OrchestratorParticipants
        environmentId={props.environmentId}
        team={team}
        value={draft}
        onChange={(patch) => update(props.threadId, patch)}
        roster={roster}
        entries={props.entries}
        models={props.models}
        {...(team
          ? {
              onLead: (row) => {
                props.onLeadChange(row.modelSelection.instanceId, row.modelSelection.model);
                chooseLead(props.threadId, props.environmentId, {
                  team: team.team,
                  role: row.role,
                });
              },
            }
          : {})}
      />
      <Button size="sm" variant="ghost" onClick={props.onExit}>
        Use ordinary chat
      </Button>
    </div>
  );
}
