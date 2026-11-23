import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DELIVERY_HARNESS_BY_DRIVER } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useGT } from "gt-react";
import {
  CrownIcon,
  GaugeIcon,
  MessageCircleIcon,
  PlusIcon,
  RepeatIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import type { DeliveryTeam } from "../../lib/delivery";
import type {
  OrchestratorAccess,
  OrchestratorCritique,
  OrchestratorExtraParticipant,
  OrchestratorLimitedSeat,
  OrchestratorParticipantAccess,
  OrchestratorParticipantChoice,
  resolveOrchestratorRoster,
} from "../../lib/orchestratorChat";
import { NO_PROVIDER_MODEL_SELECTION, type ProviderInstanceEntry } from "../../providerInstances";
import { resolveModelPickerSelectedModel } from "../chat/ModelPickerContent";
import { ProviderProblemFixButton } from "../chat/ProviderProblemFixButton";
import { TraitsPicker } from "../chat/TraitsPicker";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { getTriggerDisplayModelName, type ModelEsque } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { InfoPopover } from "./InfoPopover";
import {
  ACCESS_LEVELS,
  AccessGlyphs,
  accessLevel,
  GlyphButton,
  HarnessTile,
} from "./OrchestratorSeatGlyphs";

const CRITIQUE_ROUNDS = [
  { value: "first", label: "First message only" },
  { value: "always", label: "Every message" },
  { value: "never", label: "Never" },
];

/** The role of a participant who joins with no team behind the conversation. */
const TEAMLESS_ROLE = "participant";

/** Who joins a conversation and how, as a person is choosing it. */
export interface OrchestratorLineupValue {
  readonly participantChoices?: Readonly<Record<string, OrchestratorParticipantChoice>>;
  readonly extraParticipants?: ReadonlyArray<OrchestratorExtraParticipant>;
  readonly critique?: OrchestratorCritique;
  readonly access?: OrchestratorAccess | undefined;
  readonly limitedSeat?: OrchestratorLimitedSeat | undefined;
}

/** The participants of a team conversation, with its critique round and access. */
export function OrchestratorParticipants(props: {
  readonly environmentId: EnvironmentId;
  /** The project a thread that fixes a provider problem opens in. */
  readonly projectId: ProjectId | null;
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
  /** A board task's conversation: its team's own setting decides what a limited seat does. */
  readonly boardOwned?: boolean | undefined;
  /** What the owning panel adds to the explanation behind the info button. */
  readonly about?: ReactNode;
  /** The owning panel's own action, at the end of the footer row. */
  readonly footer?: ReactNode;
}) {
  const gt = useGT();
  const { team, value, roster } = props;
  const limitedSeatOptions: ReadonlyArray<{
    readonly value: OrchestratorLimitedSeat;
    readonly label: string;
  }> = [
    { value: "swap", label: gt("Swap automatically") },
    { value: "ask", label: gt("Ask me") },
    { value: "skip", label: gt("Leave it out") },
  ];
  const limitedSeatLabel = gt("When a seat is limited");
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
  const defaultAccess = accessLevel(value.access ?? "read-only");
  const DefaultAccessIcon = defaultAccess.icon;
  // Keeps the glyph columns of every row in line where one row has no such action.
  const noAction = <span aria-hidden className="size-7 shrink-0 sm:size-6" />;

  return (
    <div className="@container/lineup flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 text-xs font-medium">Participants</span>
        {team ? (
          <GlyphButton
            label="Reset to team"
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Reset to team"
                onClick={() => props.onChange({ participantChoices: {}, extraParticipants: [] })}
              />
            }
          >
            <Undo2Icon aria-hidden />
          </GlyphButton>
        ) : null}
        <InfoPopover label="About participants">
          {props.about ? <span className="mb-1.5 block">{props.about}</span> : null}
          <span className="block">
            <span className="font-medium text-foreground">Add participant: </span>
            any provider and model, for this conversation only.
            {team ? " Nothing is saved to the team." : ""}
          </span>
          <span className="mt-1.5 block">
            <span className="font-medium text-foreground">Critique round: </span>
            each round is one turn for every participant. Follow-up messages always get fresh
            contributions.
          </span>
          <span className="mt-1.5 block">
            <span className="font-medium text-foreground">Participants' access: </span>
            participants discuss; the orchestrator decides who does what. It can hand work that
            changes things only to a participant with access: full access lets that participant
            edit, commit, push and post. A participant's own access, set beside it, comes first, and
            a seat the team keeps read-only stays read-only unless you change it here.
          </span>
          {props.boardOwned ? null : (
            <span className="mt-1.5 block">
              <span className="font-medium text-foreground">{limitedSeatLabel}: </span>
              {gt(
                "a seat whose model has reached its usage limit moves to the first free model in your Favorites, waits for you to choose, or sits the message out. It applies from your next message. A model you chose for a seat by hand is never swapped without asking.",
              )}
            </span>
          )}
        </InfoPopover>
      </div>
      <div className="flex flex-col divide-y divide-border/60">
        {roster.rows.map((row) => {
          const selection = row.modelSelection ?? NO_PROVIDER_MODEL_SELECTION;
          const onLead = props.onLead;
          const entry = row.modelSelection
            ? (props.entries.find((item) => item.instanceId === selection.instanceId) ?? null)
            : null;
          const model: ModelEsque | null = row.modelSelection
            ? (resolveModelPickerSelectedModel({
                driverKind: entry?.driverKind,
                model: selection.model,
                options: models.get(selection.instanceId) ?? [],
              }) ?? { slug: selection.model, name: selection.model })
            : null;
          const modelName = model
            ? `${getTriggerDisplayModelName(model, entry?.driverKind)}${
                model.isUnavailable ? " (Unavailable)" : ""
              }`
            : null;
          // The orchestrator's own seat shows the orchestrator's model, so choosing here changes it.
          const lead = row.orchestrator ? onLead : undefined;
          const setModel = (modelSelection: ModelSelection) =>
            lead
              ? lead({ role: row.role, modelSelection })
              : row.extra
                ? setExtras(
                    extras.map((extra) => {
                      if (extra.id !== row.seat) return extra;
                      // A new choice by hand ends whatever stood in for the old one.
                      const { substitute: _substitute, ...kept } = extra;
                      return { ...kept, modelSelection };
                    }),
                  )
                : props.onChange({
                    participantChoices: {
                      ...value.participantChoices,
                      [row.seat]: (() => {
                        const { substitute: _substitute, ...kept } =
                          value.participantChoices?.[row.seat] ?? {};
                        return { ...kept, modelSelection, picked: true };
                      })(),
                    },
                  });
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
            <div
              key={row.seat}
              className="flex flex-col gap-1 py-1.5"
              data-orchestrator-seat={row.seat}
              role="group"
              aria-label={`Settings for ${row.title}`}
            >
              <div className="flex items-center gap-2">
                {row.extra ? (
                  <span aria-hidden className="size-4.5 shrink-0 sm:size-4" />
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
                <span className={cn("flex shrink-0", !row.included && "opacity-50")}>
                  <HarnessTile entry={entry} model={model} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cn(
                      "flex min-w-0 items-center gap-1 text-xs font-medium",
                      !row.included && "opacity-50",
                    )}
                  >
                    <span className="truncate">{row.title}</span>
                    {row.orchestrator ? (
                      <GlyphButton label="Orchestrator" render={<span className="flex shrink-0" />}>
                        <span className="flex">
                          <CrownIcon aria-hidden className="size-3 text-warning" />
                          <span className="sr-only">, orchestrator</span>
                        </span>
                      </GlyphButton>
                    ) : null}
                  </span>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1">
                    <ProviderModelPicker
                      environmentId={props.environmentId}
                      activeInstanceId={selection.instanceId}
                      model={selection.model}
                      lockedProvider={null}
                      instanceEntries={entries}
                      modelOptionsByInstance={models}
                      disabled={!row.included && !lead}
                      size="xs"
                      triggerClassName="-ml-1.75 max-w-full sm:max-w-full"
                      triggerAriaLabel={`Choose provider and model for ${row.title}`}
                      // The tile carries the logo, so the trigger is the configured model in words.
                      triggerLabel={
                        modelName === null
                          ? "Choose model"
                          : entry
                            ? `${entry.displayName} · ${modelName}`
                            : modelName
                      }
                      isComposerOwned={false}
                      onInstanceModelChange={(instanceId, picked) =>
                        setModel(
                          createModelSelection(
                            instanceId,
                            picked,
                            instanceId === selection.instanceId && picked === selection.model
                              ? selection.options
                              : undefined,
                          ),
                        )
                      }
                    />
                    {entry && row.modelSelection && !lead ? (
                      <TraitsPicker
                        provider={entry.driverKind}
                        instanceId={entry.instanceId}
                        models={entry.models}
                        model={selection.model}
                        modelOptions={selection.options}
                        allowPromptInjectedEffort={false}
                        disabled={!row.included || !entry.isAvailable}
                        size="xs"
                        onModelOptionsChange={(options) =>
                          setModel(
                            createModelSelection(selection.instanceId, selection.model, options),
                          )
                        }
                      />
                    ) : null}
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
                        <SelectTrigger
                          variant="ghost"
                          size="xs"
                          aria-label={`Role of ${row.title}`}
                        >
                          <SelectValue placeholder="Choose a role" />
                        </SelectTrigger>
                        <SelectPopup matchTriggerWidth={false}>
                          {team.roles.map((role) => (
                            <SelectItem key={role.role} value={role.role}>
                              {role.title}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    ) : null}
                  </div>
                </div>
                {row.included ? (
                  <AccessGlyphs
                    label={`Access of ${row.title}`}
                    value={row.access}
                    onChange={setAccess}
                  />
                ) : null}
                {onLead ? (
                  !row.orchestrator && !row.extra && row.modelSelection && !row.problem ? (
                    <GlyphButton
                      label={`Make ${row.title} the orchestrator`}
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Make ${row.title} the orchestrator`}
                          onClick={() => {
                            if (row.modelSelection)
                              onLead({ role: row.role, modelSelection: row.modelSelection });
                          }}
                        />
                      }
                    >
                      <CrownIcon aria-hidden />
                    </GlyphButton>
                  ) : (
                    noAction
                  )
                ) : null}
                {props.onFocus ? (
                  !row.orchestrator && row.modelSelection && !row.problem ? (
                    <GlyphButton
                      label={`Chat 1:1 with ${row.title}`}
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Chat 1:1 with ${row.title}`}
                          data-orchestrator-chat-one-to-one={row.seat}
                          onClick={() => {
                            if (row.modelSelection)
                              props.onFocus?.({
                                role: row.role,
                                modelSelection: row.modelSelection,
                              });
                          }}
                        />
                      }
                    >
                      <MessageCircleIcon aria-hidden />
                    </GlyphButton>
                  ) : (
                    noAction
                  )
                ) : null}
                {row.extra ? (
                  <GlyphButton
                    label={`Remove ${row.title}`}
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Remove ${row.title}`}
                        onClick={() => setExtras(extras.filter((extra) => extra.id !== row.seat))}
                      />
                    }
                  >
                    <XIcon aria-hidden />
                  </GlyphButton>
                ) : null}
              </div>
              {row.included && row.problem ? (
                <div className="flex items-start gap-2">
                  <p className="min-w-0 flex-1 text-xs text-warning">{row.problem}</p>
                  {row.providerProblem ? (
                    <ProviderProblemFixButton
                      environmentId={props.environmentId}
                      projectId={props.projectId}
                      problem={row.providerProblem}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-border/60 pt-2">
        {extraRole ? (
          <Button
            size="xs"
            variant="outline"
            aria-label="Add participant"
            disabled={roster.rows.filter((row) => row.included).length >= 12}
            onClick={() => setExtras([...extras, { id: nextExtraId, role: extraRole }])}
          >
            <PlusIcon aria-hidden />
            <span className="@max-[23rem]/lineup:hidden">Add participant</span>
          </Button>
        ) : null}
        <Select
          items={CRITIQUE_ROUNDS}
          value={value.critique ?? "first"}
          onValueChange={(next) => {
            if (next === "first" || next === "always" || next === "never")
              props.onChange({ critique: next });
          }}
        >
          <GlyphButton
            label="Critique round"
            render={<SelectTrigger variant="ghost" size="xs" aria-label="Critique round" />}
          >
            <span className="flex min-w-0 items-center gap-1">
              <RepeatIcon aria-hidden />
              <SelectValue />
            </span>
          </GlyphButton>
          <SelectPopup matchTriggerWidth={false}>
            {CRITIQUE_ROUNDS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          items={ACCESS_LEVELS}
          value={defaultAccess.value}
          onValueChange={(next) => {
            if (next === "approval-required" || next === "full-access")
              props.onChange({ access: next });
            else if (next === "read-only") props.onChange({ access: undefined });
          }}
        >
          <GlyphButton
            label="Participants' access"
            render={<SelectTrigger variant="ghost" size="xs" aria-label="Participants' access" />}
          >
            <span className="flex min-w-0 items-center gap-1">
              <DefaultAccessIcon
                aria-hidden
                className={cn(defaultAccess.value === "full-access" && "text-warning")}
              />
              <SelectValue />
            </span>
          </GlyphButton>
          <SelectPopup matchTriggerWidth={false}>
            {ACCESS_LEVELS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {props.boardOwned ? null : (
          <Select
            items={limitedSeatOptions}
            value={roster.limitedSeat}
            onValueChange={(next) => {
              if (next === "swap" || next === "ask" || next === "skip")
                props.onChange({ limitedSeat: next });
            }}
          >
            <GlyphButton
              label={limitedSeatLabel}
              render={<SelectTrigger variant="ghost" size="xs" aria-label={limitedSeatLabel} />}
            >
              <span className="flex min-w-0 items-center gap-1">
                <GaugeIcon aria-hidden />
                <SelectValue />
              </span>
            </GlyphButton>
            <SelectPopup matchTriggerWidth={false}>
              {limitedSeatOptions.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        {props.footer ? <span className="ml-auto flex shrink-0">{props.footer}</span> : null}
      </div>
      {roster.problem ? (
        <p role="alert" className="text-xs text-warning">
          {roster.problem}
        </p>
      ) : null}
    </div>
  );
}
