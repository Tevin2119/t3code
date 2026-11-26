import {
  resolveEnvironmentMachineKind,
  EnvironmentId,
  type LinkedDeliveryDiagnostic,
} from "@t3tools/contracts";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { useNavigate } from "@tanstack/react-router";
import { PlugIcon, SettingsIcon, UserRoundIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { LINKED_DIAGNOSTIC_TEXT, linkedMachineChoices } from "../../lib/linkedBoards";
import { useDeliveryEnabled } from "../../state/delivery";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useLinkedEnvironments } from "../../state/peerLinks";
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
 * Machines the environment links to follow, apart from the environments: choosing one shows that
 * machine's shared boards, read through the link rather than as an environment of their own.
 */
export function EnvironmentPicker(props: {
  readonly value: EnvironmentId | null;
  readonly onChoose: (environment: string) => void;
  readonly compact?: boolean;
  /** The linked machine chosen, when one is. Provided with `onChooseLinked`, which its choice calls. */
  readonly linkedValue?: string | null;
  readonly onChooseLinked?: ((peerEnvironmentId: string) => void) | undefined;
  /** What the linked boards read said per machine, when it ran: a quiet line for one that did not answer. */
  readonly linkedDiagnostics?: ReadonlyMap<string, LinkedDeliveryDiagnostic | null> | undefined;
}) {
  const { environments, isReady } = useEnvironments();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const links = useLinkedEnvironments(props.value);
  const linked = useMemo(
    () =>
      props.onChooseLinked
        ? linkedMachineChoices(
            links,
            query,
            environments.map((environment) => environment.environmentId),
          )
        : [],
    [environments, links, props.onChooseLinked, query],
  );
  const groups = groupWorkspaceEnvironments(environments, query);
  const current = environments.find((environment) => environment.environmentId === props.value);
  const currentLink = props.linkedValue
    ? (links.get(EnvironmentId.make(props.linkedValue)) ?? null)
    : null;
  const label = currentLink
    ? `${currentLink} (linked)`
    : current
      ? environmentWorkspaceLabel(current)
      : "Choose environment";
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Combobox
        items={[
          ...groups.flatMap((group) =>
            group.environments.map((environment) => environment.environmentId),
          ),
          ...linked.map((machine) => machine.environmentId),
        ]}
        inputValue={query}
        onInputValueChange={setQuery}
        onOpenChange={(open) => open && setQuery("")}
        filter={null}
        disabled={!isReady || (environments.length === 0 && linked.length === 0)}
        value={props.linkedValue ?? props.value}
        onValueChange={(value) => {
          if (!value) return;
          if (linked.some((machine) => machine.environmentId === value)) {
            props.onChooseLinked?.(String(value));
          } else if (value !== props.value) {
            props.onChoose(String(value));
          }
        }}
        itemToStringLabel={(environmentId) =>
          environments.find((environment) => environment.environmentId === environmentId)
            ?.serverConfig?.environment.workspace?.profileLabel ??
          environments.find((environment) => environment.environmentId === environmentId)?.label ??
          links.get(EnvironmentId.make(environmentId)) ??
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
          {currentLink ? (
            <PlugIcon className="size-3.5 shrink-0" />
          ) : current?.serverConfig?.environment.workspace ? (
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
            {linked.length > 0 ? (
              <div role="group" aria-label="Linked machines" data-linked-machines={linked.length}>
                <div className="flex items-center gap-2">
                  <PlugIcon className="size-3.5" />
                  Linked machines
                </div>
                {linked.map((machine) => (
                  <LinkedMachineOption
                    key={machine.environmentId}
                    machine={machine}
                    {...(props.linkedDiagnostics
                      ? {
                          diagnostic: props.linkedDiagnostics.get(machine.environmentId) ?? null,
                        }
                      : {})}
                  />
                ))}
              </div>
            ) : null}
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

function LinkedMachineOption(props: {
  readonly machine: { readonly environmentId: string; readonly label: string };
  readonly diagnostic?: LinkedDeliveryDiagnostic | null;
}) {
  return (
    <ComboboxItem value={props.machine.environmentId}>
      <span className="flex min-w-0 items-center gap-2">
        <PlugIcon className="size-4 shrink-0" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{props.machine.label}</span>
          {props.diagnostic ? (
            <span className="text-xs text-muted-foreground">
              {LINKED_DIAGNOSTIC_TEXT[props.diagnostic]}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Linked machine</span>
          )}
        </span>
      </span>
    </ComboboxItem>
  );
}
