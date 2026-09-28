import { DELIVERY_HARNESS_BY_DRIVER, type EnvironmentId } from "@t3tools/contracts";
import { InfoIcon, UsersIcon } from "lucide-react";
import { useMemo } from "react";

import { parseTeams, resolveTeamChoice, rolesForHarness } from "../../lib/delivery";
import {
  useDeliveryDraftStore,
  useDeliveryEnabled,
  useDeliveryRead,
  useDraftTeamChoice,
} from "../../state/delivery";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TeamProfilePanel } from "./TeamProfilePanel";

const NO_TEAM = "__none__";

/**
 * Team profile and role for a thread that has not been sent yet, between the
 * model and the reasoning controls. Once the thread is sent its team and role
 * are fixed, so this is only shown for drafts.
 */
export function TeamPicker(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: string;
  /** The driver of the harness chosen for this thread, e.g. `claudeAgent`. */
  readonly driver: string | null;
}) {
  const enabled = useDeliveryEnabled(props.environmentId);
  const choice = useDraftTeamChoice(props.threadId);
  const setChoice = useDeliveryDraftStore((state) => state.setChoice);
  const teamsRead = useDeliveryRead(enabled ? props.environmentId : null, "/api/teams");
  const teams = useMemo(
    () => parseTeams(teamsRead.body).filter((team) => team.team !== "triage"),
    [teamsRead.body],
  );
  const harness = props.driver ? (DELIVERY_HARNESS_BY_DRIVER[props.driver] ?? null) : null;
  const team = teams.find((candidate) => candidate.team === choice.team) ?? null;
  const offered = team && harness ? rolesForHarness(team, harness) : null;
  const resolved = resolveTeamChoice({
    teams,
    team: choice.team,
    role: choice.role,
    driver: props.driver,
  });

  if (!enabled) return null;

  const role = resolved.state === "ready" ? resolved.role : null;
  const detail = teamsRead.error
    ? `Delivery engine not reachable. ${teamsRead.error}`
    : resolved.state === "blocked"
      ? resolved.why
      : resolved.state === "choose-role"
        ? "Choose the role this harness is to take in the team."
        : resolved.state === "ready"
          ? `Team ${resolved.team}, role ${resolved.role}. Fixed once the thread is sent.`
          : "No team: an ordinary thread, with no team instructions or tools.";
  const attention = Boolean(teamsRead.error) || resolved.state === "blocked";

  return (
    <div className="flex min-w-0 items-center gap-0.5" data-delivery-team-picker>
      <Tooltip>
        <Select
          value={choice.team ?? NO_TEAM}
          onValueChange={(value) =>
            setChoice(props.threadId, {
              team: value === NO_TEAM ? null : String(value),
              role: null,
            })
          }
        >
          <TooltipTrigger
            render={
              <SelectTrigger
                aria-label="Team profile"
                size="compact"
                variant="ghost"
                className={attention ? "w-auto min-w-0 text-warning" : "w-auto min-w-0"}
              />
            }
          >
            <UsersIcon className="size-3.5" />
            <SelectValue>{choice.team ?? "No team"}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {teams.map((item) => (
              <SelectItem key={item.team} value={item.team}>
                <span className="flex flex-col">
                  <span>{item.team}</span>
                  <span className="text-xs text-muted-foreground">{item.purpose}</span>
                </span>
              </SelectItem>
            ))}
            <SelectItem value={NO_TEAM}>
              <span className="flex flex-col">
                <span>No team</span>
                <span className="text-xs text-muted-foreground">An ordinary thread</span>
              </span>
            </SelectItem>
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{detail}</TooltipPopup>
      </Tooltip>

      {team && offered ? (
        <Select
          value={role ?? ""}
          onValueChange={(value) =>
            setChoice(props.threadId, { team: choice.team, role: String(value) })
          }
        >
          <SelectTrigger
            aria-label="Role"
            size="compact"
            variant="ghost"
            className={
              resolved.state === "choose-role" ? "w-auto min-w-0 text-warning" : "w-auto min-w-0"
            }
          >
            <SelectValue>{role ?? "Choose a role"}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {offered.roles.map((item) => (
              <SelectItem key={item.role} value={item.role}>
                <span className="flex max-w-80 flex-col">
                  <span>
                    {item.title}
                    {item.role === offered.held ? " (this harness's own)" : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">{item.summary}</span>
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}

      {team ? (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Inspect team setup"
                data-delivery-inspect
              />
            }
          >
            <InfoIcon />
          </PopoverTrigger>
          <PopoverPopup side="top" align="start" className="w-[34rem] max-w-[calc(100vw-2rem)]">
            <PopoverTitle className="pb-2 text-sm">What this session is given</PopoverTitle>
            <TeamProfilePanel
              environmentId={props.environmentId}
              team={team.team}
              harness={harness}
              role={role}
            />
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}
