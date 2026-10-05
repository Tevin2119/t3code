import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { useNavigate } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";

import { useDeliveryEnabled } from "../../state/delivery";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { matchesEnvironmentSearch } from "../../lib/deliveryEnvironments";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { Button } from "../ui/button";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";

/**
 * Which added environment's engine the Board shows. The list comes from T3's Connections settings.
 */
export function EnvironmentPicker(props: {
  readonly value: EnvironmentId | null;
  readonly onChoose: (environment: string) => void;
  readonly compact?: boolean;
}) {
  const { environments, isReady } = useEnvironments();
  const navigate = useNavigate();
  const current = environments.find((environment) => environment.environmentId === props.value);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Combobox
        items={environments.map((environment) => environment.environmentId)}
        disabled={!isReady || environments.length === 0}
        value={props.value}
        onValueChange={(value) => value && value !== props.value && props.onChoose(String(value))}
        itemToStringLabel={(environmentId) =>
          environments.find((environment) => environment.environmentId === environmentId)?.label ??
          environmentId
        }
        filter={(environmentId, query) => {
          const environment = environments.find((item) => item.environmentId === environmentId);
          return environment ? matchesEnvironmentSearch(environment, query) : false;
        }}
      >
        <ComboboxTrigger
          render={
            <Button
              size={props.compact ? "icon-sm" : "xs"}
              variant="ghost"
              className="min-w-0 max-w-full"
            />
          }
          aria-label={`Board environment: ${current?.label ?? "Choose environment"}`}
          title={current?.label ?? "Choose board environment"}
          data-board-environment
        >
          <EnvironmentMachineIcon
            kind={resolveEnvironmentMachineKind(current?.serverConfig ?? null)}
            className="size-3.5 shrink-0"
          />
          <span className={props.compact ? "sr-only" : "truncate"}>
            {current?.label ?? (isReady ? "Choose environment" : "Loading environments")}
          </span>
        </ComboboxTrigger>
        <ComboboxPopup className="w-80 max-w-[calc(100vw-2rem)]">
          <ComboboxSearchInput
            aria-label="Search environments"
            placeholder="Search name or address"
          />
          <ComboboxEmpty>No environment matches.</ComboboxEmpty>
          <ComboboxList className="max-h-64">
            {(environmentId: EnvironmentId) => {
              const environment = environments.find((item) => item.environmentId === environmentId);
              return environment ? (
                <EnvironmentOption key={environmentId} environment={environment} />
              ) : null;
            }}
          </ComboboxList>
          <div className="border-t border-border/50 p-1">
            <Button
              size="xs"
              variant="ghost"
              className="w-full justify-start"
              onClick={() => void navigate({ to: "/settings/connections" })}
            >
              <SettingsIcon className="size-3.5" />
              Manage environments
            </Button>
          </div>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}

function EnvironmentOption({ environment }: { readonly environment: EnvironmentPresentation }) {
  const enabled = useDeliveryEnabled(environment.environmentId);
  return (
    <ComboboxItem value={environment.environmentId}>
      <span className="flex min-w-0 items-center gap-2">
        <EnvironmentMachineIcon
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-4 shrink-0"
        />
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{environment.label}</span>
          <span className="text-xs text-muted-foreground">
            {connectionStatusTitle(environment.connection)}
          </span>
          {enabled ? null : (
            <span className="text-xs text-muted-foreground">
              Delivery is off in this environment
            </span>
          )}
        </span>
      </span>
    </ComboboxItem>
  );
}
