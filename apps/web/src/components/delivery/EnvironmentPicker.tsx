import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { useNavigate } from "@tanstack/react-router";
import { SettingsIcon, UserRoundIcon } from "lucide-react";
import { useState } from "react";

import { useDeliveryEnabled } from "../../state/delivery";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import {
  environmentWorkspaceLabel,
  groupWorkspaceEnvironments,
} from "../../lib/deliveryEnvironments";
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
  const [query, setQuery] = useState("");
  const groups = groupWorkspaceEnvironments(environments, query);
  const current = environments.find((environment) => environment.environmentId === props.value);
  const label = current ? environmentWorkspaceLabel(current) : "Choose environment";
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Combobox
        items={groups.flatMap((group) =>
          group.environments.map((environment) => environment.environmentId),
        )}
        inputValue={query}
        onInputValueChange={setQuery}
        onOpenChange={(open) => open && setQuery("")}
        filter={null}
        disabled={!isReady || environments.length === 0}
        value={props.value}
        onValueChange={(value) => value && value !== props.value && props.onChoose(String(value))}
        itemToStringLabel={(environmentId) =>
          environments.find((environment) => environment.environmentId === environmentId)
            ?.serverConfig?.environment.workspace?.profileLabel ??
          environments.find((environment) => environment.environmentId === environmentId)?.label ??
          environmentId
        }
      >
        <ComboboxTrigger
          render={
            <Button
              size={props.compact ? "icon-sm" : "xs"}
              variant="ghost"
              className="min-w-0 max-w-full"
            />
          }
          aria-label={`Board workspace: ${label}`}
          title={label}
          data-board-environment
        >
          {current?.serverConfig?.environment.workspace ? (
            <UserRoundIcon className="size-3.5 shrink-0" />
          ) : (
            <EnvironmentMachineIcon
              kind={resolveEnvironmentMachineKind(current?.serverConfig ?? null)}
              className="size-3.5 shrink-0"
            />
          )}
          <span className={props.compact ? "sr-only" : "truncate"}>
            {current ? label : isReady ? "Choose environment" : "Loading environments"}
          </span>
        </ComboboxTrigger>
        <ComboboxPopup className="w-80 max-w-[calc(100vw-2rem)]">
          <ComboboxSearchInput
            aria-label="Search environments"
            placeholder="Search machine, profile or address"
          />
          <ComboboxEmpty>No environment matches.</ComboboxEmpty>
          <ComboboxList className="max-h-64">
            {groups.map((group) => (
              <div key={group.id} role="group" aria-label={group.label}>
                <div className="flex items-center gap-2">
                  <EnvironmentMachineIcon
                    kind={resolveEnvironmentMachineKind(
                      group.environments[0]?.serverConfig ?? null,
                    )}
                    className="size-3.5"
                  />
                  {group.label}
                </div>
                {group.environments.map((environment) => (
                  <EnvironmentOption key={environment.environmentId} environment={environment} />
                ))}
              </div>
            ))}
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
        {environment.serverConfig?.environment.workspace ? (
          <UserRoundIcon className="size-4 shrink-0" />
        ) : (
          <EnvironmentMachineIcon
            kind={resolveEnvironmentMachineKind(environment.serverConfig)}
            className="size-4 shrink-0"
          />
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate">
            {environment.serverConfig?.environment.workspace?.profileLabel ?? environment.label}
          </span>
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
