import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";

import { useDeliveryEnabled } from "../../state/delivery";
import { useEnvironments } from "../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Button } from "../ui/button";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";

/**
 * Which added environment's engine the Board shows. The list comes from T3's Connections settings.
 */
export function EnvironmentPicker(props: {
  readonly value: EnvironmentId | null;
  readonly onChoose: (environment: string) => void;
}) {
  const { environments, isReady } = useEnvironments();
  const navigate = useNavigate();
  const current = environments.find((environment) => environment.environmentId === props.value);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Select
        disabled={!isReady || environments.length === 0}
        value={props.value ?? ""}
        onValueChange={(value) => value && value !== props.value && props.onChoose(String(value))}
      >
        <SelectTrigger
          aria-label="Environment whose engine the board shows"
          size="compact"
          variant="default"
          className="w-auto min-w-0 max-w-full"
          data-board-environment
        >
          <EnvironmentMachineIcon kind="server" className="size-3.5 shrink-0" />
          <SelectValue>
            {current?.label ?? (isReady ? "Choose environment" : "Loading environments")}
          </SelectValue>
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
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Manage environments in Connections settings"
        onClick={() => void navigate({ to: "/settings/connections" })}
      >
        <SettingsIcon className="size-3.5" />
      </Button>
    </div>
  );
}

function EnvironmentOption(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const enabled = useDeliveryEnabled(props.environmentId);
  return (
    <SelectItem value={props.environmentId}>
      <span className="flex max-w-96 flex-col">
        <span>{props.label}</span>
        {enabled ? null : (
          <span className="text-xs text-muted-foreground">Delivery is off in this environment</span>
        )}
      </span>
    </SelectItem>
  );
}
