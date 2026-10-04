import type { EnvironmentId } from "@t3tools/contracts";
import { InfoIcon, UsersIcon } from "lucide-react";
import { useId } from "react";

import { seatOverrides, type SeatForThread } from "../../lib/deliverySeats";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SetupPanel } from "./SetupPanel";
import { TeamProfilePanel } from "./TeamProfilePanel";
import { useDraftTeamPicker } from "./useDraftTeamPicker";

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
  /** What is chosen for the thread now, to be held against what its seat has. */
  readonly chosen: {
    readonly model: string | null;
    readonly reasoning: string | null;
    readonly runtimeMode: string | null;
  };
  /**
   * Sets the thread to what its seat runs on. `inherit` is asked once for each
   * choice of a seat and leaves the access as the person has it: a thread is
   * never given more access by itself. `inherit-level` leaves the model too,
   * where the person has just picked it. `reset` is a person going back to the
   * seat, access included.
   */
  readonly onSeat: (seat: SeatForThread, how: "inherit" | "inherit-level" | "reset") => void;
}) {
  const { onSeat, chosen } = props;
  const picker = useDraftTeamPicker({
    environmentId: props.environmentId,
    threadId: props.threadId,
    driver: props.driver,
    onSeat,
  });
  const warningId = useId();
  const { choice, teams, team, harness, offered, resolved, role, threadSeat, warning } = picker;
  const overrides = threadSeat && !picker.takeoverOver ? seatOverrides(threadSeat, chosen) : [];

  if (!picker.enabled) return null;

  const seat =
    team && harness && role
      ? (team.seats.find((item) => item.harness === harness && item.role === role) ?? null)
      : null;
  const detail = warning
    ? warning.detail
    : picker.loading
      ? `Team ${choice.team}. Teams are still loading.`
      : resolved.state === "choose-role"
        ? "Choose the role this harness is to take in the team."
        : resolved.state === "ready"
          ? `Team ${resolved.team}, role ${resolved.role}. A conversation with that seat: sending here puts nothing on the Board. Work for the team is started with New task on the Board. Fixed once the thread is sent.`
          : "No team: an ordinary thread, with no team instructions or tools. Sending here puts nothing on the Board.";
  const chooseRole = !picker.loading && resolved.state === "choose-role";

  return (
    <div className="flex min-w-0 items-center gap-0.5" data-delivery-team-picker>
      <Tooltip>
        <Select
          value={choice.team ?? NO_TEAM}
          onValueChange={(value) => picker.setTeam(value === NO_TEAM ? null : String(value))}
        >
          <TooltipTrigger
            render={
              <SelectTrigger
                aria-label="Team profile"
                aria-describedby={warning ? warningId : undefined}
                size="compact"
                variant="ghost"
                className={warning ? "w-auto min-w-0 text-warning" : "w-auto min-w-0"}
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
            <p
              className="max-w-72 border-t border-border px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground"
              data-delivery-thread-note
            >
              A thread is a conversation, with or without a team seat. Sending here puts nothing on
              the Board; tasks are started with New task on the Board.
            </p>
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{detail}</TooltipPopup>
      </Tooltip>

      {/* Said in words beside the team: a colour and a tooltip are not seen by everyone. */}
      {warning ? (
        <span id={warningId} className="shrink-0 text-xs text-warning" data-delivery-team-warning>
          {warning.short}
        </span>
      ) : null}

      {team && offered ? (
        <Select value={role ?? ""} onValueChange={(value) => picker.setRole(String(value))}>
          <SelectTrigger
            aria-label="Role"
            size="compact"
            variant="ghost"
            className={chooseRole ? "w-auto min-w-0 text-warning" : "w-auto min-w-0"}
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

      {threadSeat && overrides.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="min-w-0 gap-1 px-1.5 font-normal text-warning"
                data-delivery-seat-overrides={overrides.map((item) => item.setting).join(" ")}
                onClick={() => onSeat(threadSeat, "reset")}
              />
            }
          >
            {overrides.length === 1 ? "1 override" : `${overrides.length} overrides`}
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-96">
            <span className="flex flex-col gap-0.5">
              <span>This thread does not run as its seat does:</span>
              {overrides.map((item) => (
                <span key={item.setting}>
                  {item.setting}: {item.chosen}, where the seat has {item.seat}
                </span>
              ))}
              <span>Your choice stands and is recorded. Click to go back to the seat.</span>
            </span>
          </TooltipPopup>
        </Tooltip>
      ) : threadSeat ? (
        <span className="sr-only" data-delivery-seat-overrides="">
          Runs as its seat does
        </span>
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
          <PopoverPopup side="top" align="start" className="w-[38rem] max-w-[calc(100vw-2rem)]">
            <PopoverTitle className="pb-2 text-sm">What this session is given</PopoverTitle>
            {seat ? (
              <SetupPanel environmentId={props.environmentId} team={team.team} seat={seat.seat} />
            ) : (
              // A role no seat holds on this harness: the session is a seat of its own.
              <TeamProfilePanel
                environmentId={props.environmentId}
                team={team.team}
                harness={harness}
                role={role}
              />
            )}
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}
