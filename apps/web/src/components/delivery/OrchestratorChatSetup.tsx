import {
  DELIVERY_HARNESS_BY_DRIVER,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveTeamChoice, rolesForHarness, selectableTeams } from "../../lib/delivery";
import { resolveOrchestratorRoster } from "../../lib/orchestratorChat";
import { NO_PROVIDER_MODEL_SELECTION, type ProviderInstanceEntry } from "../../providerInstances";
import {
  useDeliveryDraftStore,
  useDeliveryRead,
  useDraftTeamChoice,
  useOrchestratorDraft,
  useOrchestratorDraftStore,
} from "../../state/delivery";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import type { ModelEsque } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const CRITIQUE_ROUNDS = [
  { value: "first", label: "First message only" },
  { value: "always", label: "Every message" },
  { value: "never", label: "Never" },
];

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
  const teams = selectableTeams(read.body);
  const team = teams.find((item) => item.team === draft?.team) ?? null;
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
    choices: draft?.participantChoices,
    entries: props.entries,
    critique: draft?.critique,
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
  for (const selection of [props.lead, ...roster.rows.map((row) => row.modelSelection)]) {
    if (!selection) continue;
    const options = models.get(selection.instanceId) ?? [];
    if (!options.some((model) => model.slug === selection.model)) {
      models.set(selection.instanceId, [
        ...options,
        { slug: selection.model, name: selection.model },
      ]);
    }
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
        value={team?.team ?? ""}
        onValueChange={(value) => {
          if (typeof value !== "string" || !value) return;
          chooseTeam(props.threadId, props.environmentId, value);
          chooseLead(props.threadId, props.environmentId, { team: value, role: null });
        }}
      >
        <SelectTrigger aria-label="Orchestrator team">
          <SelectValue placeholder="Choose a team" />
        </SelectTrigger>
        <SelectPopup>
          {teams.map((item) => (
            <SelectItem key={item.team} value={item.team}>
              {item.team}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
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
      {resolved.state === "blocked" ? (
        <p role="alert" className="text-xs text-warning">
          {resolved.why}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Participants</span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => update(props.threadId, { participantChoices: {} })}
        >
          Reset to team
        </Button>
      </div>
      {roster.rows.map((row) => {
        const selection = row.modelSelection ?? NO_PROVIDER_MODEL_SELECTION;
        return (
          <div key={row.seat} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Checkbox
                aria-label={`Include ${row.title}`}
                checked={row.included}
                onCheckedChange={(included) =>
                  update(props.threadId, {
                    participantChoices: {
                      ...draft.participantChoices,
                      [row.seat]: { ...draft.participantChoices?.[row.seat], included },
                    },
                  })
                }
              />
              <span className="min-w-0 flex-1 text-xs">{row.title}</span>
              <ProviderModelPicker
                environmentId={props.environmentId}
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={models}
                disabled={!row.included}
                triggerAriaLabel={`Choose provider and model for ${row.title}`}
                {...(row.modelSelection === null ? { triggerLabel: "Choose model" } : {})}
                isComposerOwned={false}
                onInstanceModelChange={(instanceId, model) =>
                  update(props.threadId, {
                    participantChoices: {
                      ...draft.participantChoices,
                      [row.seat]: {
                        ...draft.participantChoices?.[row.seat],
                        modelSelection: createModelSelection(
                          instanceId,
                          model,
                          instanceId === selection.instanceId && model === selection.model
                            ? selection.options
                            : undefined,
                        ),
                      },
                    },
                  })
                }
              />
            </div>
            {row.included && row.problem ? (
              <p className="text-xs text-warning">{row.problem}</p>
            ) : null}
          </div>
        );
      })}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">Critique round</span>
        <Select
          items={CRITIQUE_ROUNDS}
          value={draft.critique ?? "first"}
          onValueChange={(value) => {
            if (value === "first" || value === "always" || value === "never")
              update(props.threadId, { critique: value });
          }}
        >
          <SelectTrigger aria-label="Critique round">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {CRITIQUE_ROUNDS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <p className="text-xs text-muted-foreground">
          Each round is one turn for every participant. Follow-up messages always get fresh
          contributions.
        </p>
      </div>
      {roster.problem ? (
        <p role="alert" className="text-xs text-warning">
          {roster.problem}
        </p>
      ) : null}
      <Button size="sm" variant="ghost" onClick={props.onExit}>
        Use ordinary chat
      </Button>
    </div>
  );
}
