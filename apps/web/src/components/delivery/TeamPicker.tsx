import type { EnvironmentId } from "@t3tools/contracts";
import { UsersIcon } from "lucide-react";
import { useMemo } from "react";

import { parseTeams, resolveTeamChoice } from "../../lib/delivery";
import {
  useDeliveryDraftStore,
  useDeliveryEnabled,
  useDeliveryRead,
  useDraftTeamChoice,
} from "../../state/delivery";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const NO_TEAM = "__none__";

/**
 * Team and role for a thread that has not been sent yet. Once the thread is
 * sent its team is fixed, so this is only shown for drafts.
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
  const resolved = resolveTeamChoice({
    teams,
    team: choice.team,
    role: choice.role,
    driver: props.driver,
  });

  if (!enabled) return null;

  const detail = teamsRead.error
    ? `Delivery engine not reachable. ${teamsRead.error}`
    : resolved.state === "blocked"
      ? resolved.why
      : resolved.state === "choose-role"
        ? "This harness can take more than one role in this team. Choose one."
        : resolved.state === "ready"
          ? `Team ${resolved.team}, role ${resolved.role}. Fixed once the thread is sent.`
          : "No team: an ordinary thread, with no team instructions or tools.";
  const attention = Boolean(teamsRead.error) || resolved.state === "blocked";

  return (
    <div className="flex min-w-0 items-center gap-1" data-delivery-team-picker>
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
                aria-label="Team"
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
            {teams.map((team) => (
              <SelectItem key={team.team} value={team.team} disabled={!team.available}>
                <span className="flex flex-col">
                  <span>{team.team}</span>
                  <span className="text-xs text-muted-foreground">
                    {team.available ? team.purpose : (team.why ?? "Not available")}
                  </span>
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
      {resolved.state === "choose-role" || (resolved.state === "ready" && choice.role) ? (
        <Select
          value={choice.role ?? ""}
          onValueChange={(value) =>
            setChoice(props.threadId, { team: choice.team, role: String(value) })
          }
        >
          <SelectTrigger
            aria-label="Role"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>{choice.role ?? "Choose a role"}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {(resolved.state === "choose-role"
              ? resolved.roles
              : [
                  ...new Set(
                    teams
                      .find((team) => team.team === choice.team)
                      ?.seats.map((seat) => seat.role) ?? [],
                  ),
                ]
            ).map((role) => (
              <SelectItem key={role} value={role}>
                {role}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : resolved.state === "ready" ? (
        <span className="truncate text-xs text-muted-foreground">{resolved.role}</span>
      ) : null}
    </div>
  );
}
