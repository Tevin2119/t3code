import { DELIVERY_HARNESS_BY_DRIVER, type EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo } from "react";

import {
  resolveDraftTeam,
  resolveTeamChoice,
  rolesForHarness,
  selectableTeams,
  teamListStatus,
} from "../../lib/delivery";
import { seatForThread, seatKey, takeOverFor, type SeatForThread } from "../../lib/deliverySeats";
import {
  SEAT_TAKEOVER_OVER,
  useDeliveryDraftStore,
  useDeliveryEnabled,
  useDeliveryRead,
  useDraftTeamChoice,
  useHasDraftTeamChoice,
} from "../../state/delivery";

/**
 * What the team picker of a draft thread shows and does: the team and role
 * that stand for the thread, why they cannot be used when they cannot, and
 * the taking over of what the thread's seat runs on.
 */
export function useDraftTeamPicker(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: string;
  /** The driver of the harness chosen for this thread, e.g. `claudeAgent`. */
  readonly driver: string | null;
  readonly onSeat: (seat: SeatForThread, how: "inherit" | "inherit-level") => void;
}) {
  const { environmentId, threadId, driver, onSeat } = input;
  const enabled = useDeliveryEnabled(environmentId);
  const draft = useDraftTeamChoice(threadId, environmentId);
  const explicit = useHasDraftTeamChoice(threadId);
  const chooseTeam = useDeliveryDraftStore((state) => state.chooseTeam);
  const markInherited = useDeliveryDraftStore((state) => state.markInherited);
  const inheritedFor = useDeliveryDraftStore((state) => state.inherited[threadId] ?? null);
  const teamsRead = useDeliveryRead(enabled ? environmentId : null, "/api/teams", {
    pollMs: 10_000,
  });
  const teams = useMemo(() => selectableTeams(teamsRead.body), [teamsRead.body]);
  const status = teamListStatus(teamsRead);
  // A remembered team that is gone is "No team" here, as it is in the footer and at the send.
  const choice = resolveDraftTeam({ draft, explicit, teams, status });

  const harness = driver ? (DELIVERY_HARNESS_BY_DRIVER[driver] ?? null) : null;
  const team = teams.find((candidate) => candidate.team === choice.team) ?? null;
  const offered = team && harness ? rolesForHarness(team, harness) : null;
  const resolved = resolveTeamChoice({ teams, team: choice.team, role: choice.role, driver });
  // Until the teams are read, nothing is known to be wrong with a team.
  const loading = choice.team !== null && status === "pending";

  const role = resolved.state === "ready" ? resolved.role : null;
  const threadSeat = team && harness && role ? seatForThread(team.settings, harness, role) : null;
  const inheritKey = team && role && threadSeat ? seatKey(team.team, role, threadSeat) : null;
  // A thread bound to a seat runs on what the seat runs on, unless a person
  // chooses otherwise after that. The draft is set from the seat once for each
  // seat that is chosen, here, because the seat also changes when the harness does.
  useEffect(() => {
    if (!enabled || !inheritKey || !threadSeat || inheritedFor === inheritKey) return;
    if (inheritedFor === SEAT_TAKEOVER_OVER) return;
    onSeat(threadSeat, takeOverFor(inheritedFor, threadSeat));
    markInherited(threadId, inheritKey);
  }, [enabled, inheritKey, threadSeat, inheritedFor, onSeat, markInherited, threadId]);

  const ownSeat = team && harness ? team.seats.some((seat) => seat.harness === harness) : false;
  // Why the team cannot be used as it stands: a few words to show, and the whole of it.
  const warning: { readonly short: string; readonly detail: string } | null = loading
    ? null
    : teamsRead.error
      ? {
          short: "Engine not reachable",
          detail: `Delivery engine not reachable. ${teamsRead.error}`,
        }
      : resolved.state === "blocked"
        ? {
            short: !team
              ? "Team not set up"
              : !harness
                ? "No seat for this harness"
                : "Harness unavailable",
            detail: resolved.why,
          }
        : resolved.state === "choose-role" && !ownSeat
          ? {
              short: "No seat for this harness",
              detail: `This harness has no seat of its own in team ${resolved.team}. Choose the role it is to take, or No team.`,
            }
          : null;

  const setTeam = useCallback(
    (next: string | null) => chooseTeam(threadId, environmentId, { team: next, role: null }),
    [chooseTeam, environmentId, threadId],
  );
  const teamName = choice.team;
  const setRole = useCallback(
    (next: string) => chooseTeam(threadId, environmentId, { team: teamName, role: next }),
    [chooseTeam, environmentId, teamName, threadId],
  );

  return {
    enabled,
    teams,
    choice,
    team,
    harness,
    offered,
    resolved,
    role,
    loading,
    warning,
    threadSeat,
    /** Whether what the seat runs on is no longer taken over: the thread was sent. */
    takeoverOver: inheritedFor === SEAT_TAKEOVER_OVER,
    setTeam,
    setRole,
  };
}
