import {
  DELIVERY_HARNESS_BY_DRIVER,
  type DeliveryOrchestrationConfig,
  type ModelSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  defaultModelOfProviderInstanceEntry,
  describeUnavailableProviderInstance,
  type ProviderInstanceEntry,
} from "../providerInstances";
import type { DeliveryTeam } from "./delivery";
import { REASONING_OPTION_BY_DRIVER } from "./deliverySeats";

export interface OrchestratorParticipantChoice {
  readonly included?: boolean;
  readonly modelSelection?: ModelSelection;
}

/** A participant added for one conversation: any provider and model, in one of the team's roles. */
export interface OrchestratorExtraParticipant {
  readonly id: string;
  readonly role: string;
  readonly modelSelection?: ModelSelection;
}

export type OrchestratorCritique = NonNullable<DeliveryOrchestrationConfig["critique"]>;

export function resolveOrchestratorRoster(input: {
  readonly team: DeliveryTeam | null;
  readonly choices: Readonly<Record<string, OrchestratorParticipantChoice>> | undefined;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly critique?: OrchestratorCritique | undefined;
  readonly extras?: ReadonlyArray<OrchestratorExtraParticipant> | undefined;
  /** The harness and role the orchestrator itself runs as, when known. */
  readonly orchestrator?: { readonly harness: string | null; readonly role: string | null };
}) {
  const harnessOf = (seat: DeliveryTeam["seats"][number]) =>
    input.team?.settings.find((item) => item.seat === seat.seat)?.now.harness ?? seat.harness;
  // The orchestrator already speaks for the seat it holds, so that seat sits out unless asked in.
  const ownSeat = input.team?.seats.find(
    (seat) =>
      seat.role === input.orchestrator?.role && harnessOf(seat) === input.orchestrator?.harness,
  )?.seat;
  const selectionProblem = (title: string, modelSelection: ModelSelection) => {
    const entry = input.entries.find((item) => item.instanceId === modelSelection.instanceId);
    const wayOut = `Choose another provider for ${title}, or leave it out.`;
    return !entry
      ? `${title}'s provider is unavailable. ${wayOut}`
      : !entry.enabled || !entry.installed || !entry.isAvailable || entry.status !== "ready"
        ? `${title}'s provider is unavailable. ${
            entry.installed || !entry.enabled
              ? describeUnavailableProviderInstance(entry)
              : `${entry.displayName} is not installed.`
          } ${wayOut}`
        : !DELIVERY_HARNESS_BY_DRIVER[entry.driverKind]
          ? `${entry.displayName} does not support team seats.`
          : !modelSelection.model.trim()
            ? `Choose a model for ${title}.`
            : null;
  };
  const teamRow = (seat: DeliveryTeam["seats"][number]) => {
    const settings = input.team?.settings.find((item) => item.seat === seat.seat);
    const choice = input.choices?.[seat.seat];
    const included = choice?.included ?? (settings?.now.active !== "off" && seat.seat !== ownSeat);
    const harness = harnessOf(seat);
    const candidates = input.entries.filter(
      (entry) => DELIVERY_HARNESS_BY_DRIVER[entry.driverKind] === harness && entry.enabled,
    );
    const configured = candidates.length === 1 ? candidates[0] : undefined;
    const seatModel = settings?.now.model ?? seat.model;
    // A seat with no model of its own runs on its provider's default.
    const model =
      seatModel ?? (configured ? defaultModelOfProviderInstanceEntry(configured) : undefined);
    const option = configured ? REASONING_OPTION_BY_DRIVER[configured.driverKind] : undefined;
    const modelSelection =
      choice?.modelSelection ??
      (configured && model
        ? createModelSelection(
            configured.instanceId,
            model,
            option && settings?.now.reasoning
              ? [{ id: option, value: settings.now.reasoning }]
              : undefined,
          )
        : null);
    const problem = !modelSelection
      ? candidates.length === 0
        ? `No enabled provider runs ${harness}, which ${seat.title} is set to. Choose another provider for ${seat.title}, or leave it out.`
        : candidates.length > 1
          ? `More than one provider runs ${harness}. Choose the one ${seat.title} uses.`
          : `Choose a model for ${seat.title}.`
      : selectionProblem(seat.title, modelSelection);
    return {
      seat: seat.seat,
      title: seat.title,
      role: seat.role,
      included,
      modelSelection,
      /** The seat the orchestrator itself holds. */
      orchestrator: seat.seat === ownSeat,
      extra: false,
      problem,
    };
  };
  const teamRows = (input.team?.seats ?? []).map(teamRow);
  const rows = [
    ...teamRows,
    ...(input.extras ?? []).map((extra, index) => {
      const title = `Extra participant ${index + 1}`;
      return {
        seat: extra.id,
        title,
        role: extra.role,
        included: true,
        modelSelection: extra.modelSelection ?? null,
        orchestrator: false,
        extra: true,
        problem: !input.team?.roles.some((role) => role.role === extra.role)
          ? `Choose a role for ${title}.`
          : !extra.modelSelection
            ? `Choose a provider and model for ${title}.`
            : selectionProblem(title, extra.modelSelection),
      };
    }),
  ];
  const selected = rows.filter((row) => row.included);
  const stale = Object.keys(input.choices ?? {}).some(
    (seat) => !teamRows.some((row) => row.seat === seat),
  );
  const identities = new Set(
    selected.map((row) => `${row.modelSelection?.instanceId}:${row.modelSelection?.model}`),
  );
  const problem = !input.team
    ? "Choose a team for this conversation."
    : stale
      ? "The team's seats changed. Use Reset to team to refresh its participants."
      : selected.length < 2 || selected.length > 12
        ? "Choose between 2 and 12 participants."
        : (selected.find((row) => row.problem)?.problem ??
          (identities.size !== selected.length
            ? "Choose a different provider or model for each participant."
            : null));
  const configuration: DeliveryOrchestrationConfig | null = problem
    ? null
    : {
        ...(input.critique && input.critique !== "first" ? { critique: input.critique } : {}),
        participants: selected.flatMap((row) =>
          row.modelSelection
            ? [{ seat: row.seat, role: row.role, modelSelection: row.modelSelection }]
            : [],
        ),
      };
  return { rows, configuration, problem };
}
