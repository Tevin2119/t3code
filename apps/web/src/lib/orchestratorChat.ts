import {
  DELIVERY_HARNESS_BY_DRIVER,
  type DeliveryOrchestrationConfig,
  type ModelSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import type { ProviderInstanceEntry } from "../providerInstances";
import type { DeliveryTeam } from "./delivery";
import { REASONING_OPTION_BY_DRIVER } from "./deliverySeats";

export interface OrchestratorParticipantChoice {
  readonly included?: boolean;
  readonly modelSelection?: ModelSelection;
}

export function resolveOrchestratorRoster(input: {
  readonly team: DeliveryTeam | null;
  readonly choices: Readonly<Record<string, OrchestratorParticipantChoice>> | undefined;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
}) {
  const rows = (input.team?.seats ?? []).map((seat) => {
    const settings = input.team?.settings.find((item) => item.seat === seat.seat);
    const choice = input.choices?.[seat.seat];
    const included = choice?.included ?? settings?.now.active !== "off";
    const harness = settings?.now.harness ?? seat.harness;
    const candidates = input.entries.filter(
      (entry) => DELIVERY_HARNESS_BY_DRIVER[entry.driverKind] === harness && entry.enabled,
    );
    const configured = candidates.length === 1 ? candidates[0] : undefined;
    const model = settings?.now.model ?? seat.model;
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
    const entry = input.entries.find((item) => item.instanceId === modelSelection?.instanceId);
    const problem = !modelSelection
      ? `Choose a provider and model for ${seat.title}.`
      : !entry ||
          !entry.enabled ||
          !entry.installed ||
          !entry.isAvailable ||
          entry.status !== "ready"
        ? `${seat.title}'s provider is unavailable.`
        : !DELIVERY_HARNESS_BY_DRIVER[entry.driverKind]
          ? `${entry.displayName} does not support team seats.`
          : !modelSelection.model.trim()
            ? `Choose a model for ${seat.title}.`
            : null;
    return {
      seat: seat.seat,
      title: seat.title,
      role: seat.role,
      included,
      modelSelection,
      problem,
    };
  });
  const selected = rows.filter((row) => row.included);
  const stale = Object.keys(input.choices ?? {}).some(
    (seat) => !rows.some((row) => row.seat === seat),
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
        participants: selected.flatMap((row) =>
          row.modelSelection
            ? [{ seat: row.seat, role: row.role, modelSelection: row.modelSelection }]
            : [],
        ),
      };
  return { rows, configuration, problem };
}
