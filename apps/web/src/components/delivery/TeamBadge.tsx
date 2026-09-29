import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { LockIcon, UsersIcon } from "lucide-react";

import { describeEffective, parseSessionEffective } from "../../lib/deliverySeats";
import { deliveryEnvironment, useDeliveryEnabled, useDeliveryRead } from "../../state/delivery";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { TeamProfilePanel } from "./TeamProfilePanel";

/**
 * Team profile and role of a thread that has been sent, in the place where
 * they were chosen. They are fixed for the life of the thread, so this shows
 * them and what they brought with them, and changes nothing.
 */
export function TeamBadge(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId;
}) {
  const enabled = useDeliveryEnabled(props.environmentId);
  const state = useEnvironmentQuery(
    enabled && props.environmentId
      ? deliveryEnvironment.threadBinding({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        })
      : null,
  );
  const session = state.data?.binding?.session ?? null;
  const sessionRead = useDeliveryRead(
    enabled && session ? props.environmentId : null,
    `/api/sessions/${session ?? ""}`,
    // What the harness confirms arrives after the session has started.
    { pollMs: 15_000 },
  );
  if (!enabled) return null;
  const binding = state.data?.binding ?? null;
  // A thread that was sent with no team says so, where the team would stand.
  if (!binding) {
    if (state.data === undefined || state.data === null) return null;
    return (
      <span
        className="flex min-w-0 items-center gap-1 px-1.5 text-xs text-muted-foreground"
        data-delivery-team-badge="none"
      >
        <UsersIcon className="size-3.5" />
        No team
      </span>
    );
  }
  const seat = binding.seatSettings ?? null;
  const effective = parseSessionEffective(sessionRead.body);
  const overrides = effective?.overrides ?? [];
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Team profile", binding.team],
    ["Role", binding.role],
    ["Seat", binding.seat],
    ["Harness", binding.harness],
    [
      "Seat runs on",
      seat
        ? [
            seat.model ?? "the model of the harness",
            seat.reasoning ? `${seat.reasoning} reasoning` : "the level of the harness",
            `${seat.access ?? "full"} access`,
            `from ${seat.from}`,
          ].join(", ")
        : "not recorded when this thread was bound",
    ],
    ...(effective
      ? [
          ...describeEffective(effective),
          [
            "Overrides",
            overrides.length > 0
              ? overrides
                  .map(
                    (item) =>
                      `${item.setting}: ${item.chosen ?? "nothing"}, where the seat has ${item.seat ?? "nothing"}`,
                  )
                  .join("; ")
              : "none, the thread runs as its seat does",
          ] as const,
          ...effective.notApplied.map(
            (item) => [`Not applied: ${item.setting}`, item.why] as const,
          ),
          ...effective.disagrees.map(
            (item) =>
              [
                `Differs: ${item.setting}`,
                `${item.passed ?? "nothing"} was passed, the harness reports ${item.confirmed ?? "nothing"}`,
              ] as const,
          ),
          ["Recorded", `${effective.at}, ${effective.reason ?? "no reason given"}`] as const,
        ]
      : ([["This thread runs on", "not reported yet"]] as const)),
    ["Configuration", binding.configuration],
    ["Keeps", binding.memoryScope === "profile" ? "the notes of the profile" : "this conversation"],
    ["Tools", binding.tools.length > 0 ? binding.tools.join(", ") : "none"],
    ["Bound", binding.boundAt],
  ];
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="min-w-0 gap-1 px-1.5 font-normal"
            aria-label={`Team ${binding.team}, role ${binding.role}. Fixed for this thread.`}
            data-delivery-team-badge={binding.team}
            data-delivery-team-role={binding.role}
            data-delivery-team-overrides={overrides.map((item) => item.setting).join(" ")}
          />
        }
      >
        <UsersIcon className="size-3.5 shrink-0" />
        <span className="truncate">{binding.team}</span>
        <span className="text-muted-foreground">/</span>
        <span className="truncate">{binding.role}</span>
        {overrides.length > 0 ? (
          <span className="shrink-0 text-warning">
            {overrides.length === 1 ? "1 override" : `${overrides.length} overrides`}
          </span>
        ) : null}
        <LockIcon className="size-3 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-[min(36rem,calc(100vw-2rem))]">
        <PopoverTitle>The team of this thread</PopoverTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Chosen before the thread was sent, and fixed since. A thread on another team is a new
          thread.
        </p>
        <dl
          className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"
          data-delivery-team-badge-details
        >
          {rows.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-muted-foreground">{name}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 max-h-80 overflow-auto">
          <TeamProfilePanel
            environmentId={props.environmentId}
            team={binding.team}
            harness={binding.harness}
            role={binding.role}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
