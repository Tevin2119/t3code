import type { EnvironmentId } from "@t3tools/contracts";

import { useDeliveryEnabled } from "../../state/delivery";
import { useEnvironments } from "../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/**
 * Which connected environment's engine the Board shows. Shown only when the window is connected to
 * more than one; an environment with delivery switched off is listed and cannot be chosen.
 */
export function EnvironmentPicker(props: {
  readonly value: EnvironmentId | null;
  readonly onChoose: (environment: string) => void;
}) {
  const { environments } = useEnvironments();
  if (environments.length < 2) return null;
  const current = environments.find((environment) => environment.environmentId === props.value);
  return (
    <Select
      value={props.value ?? ""}
      onValueChange={(value) => value && value !== props.value && props.onChoose(String(value))}
    >
      <SelectTrigger
        aria-label="Environment whose engine the board shows"
        size="compact"
        variant="ghost"
        className="w-auto min-w-0"
        data-board-environment
      >
        <SelectValue>{current?.label ?? "Environment"}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {environments.map((environment) => (
          <EnvironmentOption
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
          />
        ))}
      </SelectPopup>
    </Select>
  );
}

function EnvironmentOption(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const enabled = useDeliveryEnabled(props.environmentId);
  return (
    <SelectItem value={props.environmentId} disabled={!enabled}>
      <span className="flex max-w-96 flex-col">
        <span>{props.label}</span>
        {enabled ? null : (
          <span className="text-xs text-muted-foreground">Delivery is off in this environment</span>
        )}
      </span>
    </SelectItem>
  );
}
