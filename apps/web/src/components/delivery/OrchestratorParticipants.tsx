import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { DELIVERY_HARNESS_BY_DRIVER } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import type { DeliveryTeam } from "../../lib/delivery";
import type {
  OrchestratorAccess,
  OrchestratorCritique,
  OrchestratorExtraParticipant,
  OrchestratorParticipantAccess,
  OrchestratorParticipantChoice,
  resolveOrchestratorRoster,
} from "../../lib/orchestratorChat";
import { NO_PROVIDER_MODEL_SELECTION, type ProviderInstanceEntry } from "../../providerInstances";
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

const PARTICIPANT_ACCESS = [
  { value: "read-only", label: "Read-only" },
  { value: "approval-required", label: "Ask me before changes" },
  { value: "full-access", label: "Full access" },
];

/** The role of a participant who joins with no team behind the conversation. */
const TEAMLESS_ROLE = "participant";

/** Who joins a conversation and how, as a person is choosing it. */
export interface OrchestratorLineupValue {
  readonly participantChoices?: Readonly<Record<string, OrchestratorParticipantChoice>>;
  readonly extraParticipants?: ReadonlyArray<OrchestratorExtraParticipant>;
  readonly critique?: OrchestratorCritique;
  readonly access?: OrchestratorAccess | undefined;
}

/** The participants of a team conversation, with its critique round and access. */
export function OrchestratorParticipants(props: {
  readonly environmentId: EnvironmentId;
  readonly team: DeliveryTeam | null;
  readonly value: OrchestratorLineupValue;
  readonly onChange: (patch: OrchestratorLineupValue) => void;
  readonly roster: ReturnType<typeof resolveOrchestratorRoster>;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly models: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  /** Offered beside a team seat that can take over as orchestrator. */
  readonly onLead?: (row: {
    readonly role: string;
    readonly modelSelection: ModelSelection;
  }) => void;
  /** Starts a single chat with one participant's harness and model. */
  readonly onFocus?:
    | ((row: { readonly role: string; readonly modelSelection: ModelSelection }) => void)
    | undefined;
}) {
  const { team, value, roster } = props;
  const entries = props.entries.filter((entry) => DELIVERY_HARNESS_BY_DRIVER[entry.driverKind]);
  const models = new Map(props.models);
  for (const row of roster.rows) {
    const selection = row.modelSelection;
    if (!selection) continue;
    const options = models.get(selection.instanceId) ?? [];
    if (!options.some((model) => model.slug === selection.model)) {
      models.set(selection.instanceId, [
        ...options,
        { slug: selection.model, name: selection.model },
      ]);
    }
  }
  const extras = value.extraParticipants ?? [];
  const setExtras = (next: ReadonlyArray<OrchestratorExtraParticipant>) =>
    props.onChange({ extraParticipants: next });
  const nextExtraId = `custom-${
    extras.reduce((highest, extra) => Math.max(highest, Number(extra.id.slice(7)) || 0), 0) + 1
  }`;
  // A new participant takes the role of the first seat that is not the orchestrator's own.
  const extraRole = team
    ? (roster.rows.find((row) => !row.orchestrator && !row.extra)?.role ?? team.roles[0]?.role)
    : TEAMLESS_ROLE;

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Participants</span>
        {team ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => props.onChange({ participantChoices: {}, extraParticipants: [] })}
          >
            Reset to team
          </Button>
        ) : null}
      </div>
      {roster.rows.map((row) => {
        const selection = row.modelSelection ?? NO_PROVIDER_MODEL_SELECTION;
        const onLead = props.onLead;
        const setAccess = (access: OrchestratorParticipantAccess) =>
          row.extra
            ? setExtras(
                extras.map((extra) => (extra.id === row.seat ? { ...extra, access } : extra)),
              )
            : props.onChange({
                participantChoices: {
                  ...value.participantChoices,
                  [row.seat]: { ...value.participantChoices?.[row.seat], access },
                },
              });
        return (
          <div key={row.seat} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              {row.extra ? (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Remove ${row.title}`}
                  onClick={() => setExtras(extras.filter((extra) => extra.id !== row.seat))}
                >
                  Remove
                </Button>
              ) : (
                <Checkbox
                  aria-label={`Include ${row.title}`}
                  checked={row.included}
                  onCheckedChange={(included) =>
                    props.onChange({
                      participantChoices: {
                        ...value.participantChoices,
                        [row.seat]: { ...value.participantChoices?.[row.seat], included },
                      },
                    })
                  }
                />
              )}
              <span className="min-w-0 flex-1 text-xs">
                {row.title}
                {row.orchestrator ? (
                  <span className="text-muted-foreground"> · orchestrator</span>
                ) : null}
              </span>
              {onLead && !row.orchestrator && !row.extra && row.modelSelection && !row.problem ? (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Make ${row.title} the orchestrator`}
                  onClick={() => {
                    if (row.modelSelection)
                      onLead({ role: row.role, modelSelection: row.modelSelection });
                  }}
                >
                  Lead
                </Button>
              ) : null}
              {props.onFocus && !row.orchestrator && row.modelSelection && !row.problem ? (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Chat 1:1 with ${row.title}`}
                  data-orchestrator-chat-one-to-one={row.seat}
                  onClick={() => {
                    if (row.modelSelection)
                      props.onFocus?.({ role: row.role, modelSelection: row.modelSelection });
                  }}
                >
                  Chat 1:1
                </Button>
              ) : null}
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
                  row.extra
                    ? setExtras(
                        extras.map((extra) =>
                          extra.id === row.seat
                            ? { ...extra, modelSelection: createModelSelection(instanceId, model) }
                            : extra,
                        ),
                      )
                    : props.onChange({
                        participantChoices: {
                          ...value.participantChoices,
                          [row.seat]: {
                            ...value.participantChoices?.[row.seat],
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
            {row.extra && team ? (
              <Select
                items={team.roles.map((role) => ({ value: role.role, label: role.title }))}
                value={row.role}
                onValueChange={(next) => {
                  if (typeof next === "string")
                    setExtras(
                      extras.map((extra) =>
                        extra.id === row.seat ? { ...extra, role: next } : extra,
                      ),
                    );
                }}
              >
                <SelectTrigger aria-label={`Role of ${row.title}`}>
                  <SelectValue placeholder="Choose a role" />
                </SelectTrigger>
                <SelectPopup>
                  {team.roles.map((role) => (
                    <SelectItem key={role.role} value={role.role}>
                      {role.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            {row.included ? (
              <Select
                items={PARTICIPANT_ACCESS}
                value={row.access}
                onValueChange={(next) => {
                  if (
                    next === "read-only" ||
                    next === "approval-required" ||
                    next === "full-access"
                  )
                    setAccess(next);
                }}
              >
                <SelectTrigger aria-label={`Access of ${row.title}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {PARTICIPANT_ACCESS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            {row.included && row.problem ? (
              <p className="text-xs text-warning">{row.problem}</p>
            ) : null}
          </div>
        );
      })}
      {extraRole ? (
        <div className="flex flex-col gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={roster.rows.filter((row) => row.included).length >= 12}
            onClick={() => setExtras([...extras, { id: nextExtraId, role: extraRole }])}
          >
            Add participant
          </Button>
          <p className="text-xs text-muted-foreground">
            Any provider and model, for this conversation only.
            {team ? " Nothing is saved to the team." : ""}
          </p>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">Critique round</span>
        <Select
          items={CRITIQUE_ROUNDS}
          value={value.critique ?? "first"}
          onValueChange={(next) => {
            if (next === "first" || next === "always" || next === "never")
              props.onChange({ critique: next });
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
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">Participants' access</span>
        <Select
          items={PARTICIPANT_ACCESS}
          value={value.access ?? "read-only"}
          onValueChange={(next) => {
            if (next === "approval-required" || next === "full-access")
              props.onChange({ access: next });
            else if (next === "read-only") props.onChange({ access: undefined });
          }}
        >
          <SelectTrigger aria-label="Participants' access">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {PARTICIPANT_ACCESS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <p className="text-xs text-muted-foreground">
          Read-only participants discuss and cannot change anything, so only the orchestrator acts.
          With full access they can edit, commit, push and post like the orchestrator. A
          participant's own access, set beside it, comes first, and a seat the team keeps read-only
          stays read-only unless you change it here.
        </p>
      </div>
      {roster.problem ? (
        <p role="alert" className="text-xs text-warning">
          {roster.problem}
        </p>
      ) : null}
    </>
  );
}
