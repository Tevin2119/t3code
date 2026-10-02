import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { parseTrackRecord } from "../../lib/delivery";
import { harnessLabel } from "../../lib/deliverySeats";
import { useDeliveryRead } from "../../state/delivery";

const tallyText = (tally: Readonly<Record<string, number>>) =>
  Object.entries(tally)
    .map(([kind, times]) => `${kind} ${times}`)
    .join(", ");

/**
 * How each harness and model has done in each stage of a team, from what the
 * engine kept on this host: how often it was asked and answered, why it did
 * not, how long it took, and what it decided. It helps choose who sits in a
 * seat. It is not a benchmark; a row with few attempts says little.
 */
export function TrackRecord(props: {
  readonly environmentId: EnvironmentId | null;
  readonly team?: string | undefined;
}) {
  const route = props.team ? `/api/record?team=${encodeURIComponent(props.team)}` : "/api/record";
  const read = useDeliveryRead(props.environmentId, route);
  const rows = useMemo(() => parseTrackRecord(read.body), [read.body]);

  if (read.error) {
    return <p className="text-xs text-warning">The track record could not be read. {read.error}</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-track-record="empty">
        {read.body === null ? "Reading the track record." : "Nothing has run here yet."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-track-record>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-[11px]">
          <thead className="text-muted-foreground">
            <tr>
              {props.team ? null : <th className="py-1 pr-2 font-medium">Team</th>}
              <th className="py-1 pr-2 font-medium">Stage</th>
              <th className="py-1 pr-2 font-medium">Harness and model</th>
              <th className="py-1 pr-2 text-right font-medium">Answered</th>
              <th className="py-1 pr-2 text-right font-medium">Median</th>
              <th className="py-1 pr-2 font-medium">Did not answer</th>
              <th className="py-1 font-medium">Outcomes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={`${row.team}|${row.stage}|${row.harness}|${row.model ?? ""}`}>
                {props.team ? null : <td className="py-1 pr-2">{row.team}</td>}
                <td className="py-1 pr-2">{row.stage}</td>
                <td className="py-1 pr-2">
                  {harnessLabel(row.harness)}
                  <span className="text-muted-foreground">, {row.model ?? "its own model"}</span>
                </td>
                <td className="py-1 pr-2 text-right tabular-nums">
                  {row.answered} of {row.attempts}
                  {row.answeredShare !== null ? (
                    <span className="text-muted-foreground"> ({row.answeredShare}%)</span>
                  ) : null}
                </td>
                <td className="py-1 pr-2 text-right tabular-nums">
                  {row.medianSeconds === null ? "" : `${row.medianSeconds} s`}
                </td>
                <td className="py-1 pr-2 text-muted-foreground">{tallyText(row.notAnswered)}</td>
                <td className="py-1 text-muted-foreground">
                  {[
                    tallyText(row.decisions),
                    tallyText(row.verdicts),
                    row.steppedIn > 0 ? `stood in ${row.steppedIn}` : "",
                  ]
                    .filter(Boolean)
                    .join("; ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Counted from the work done on this host. It is not a benchmark: a row with few attempts says
        little.
      </p>
    </div>
  );
}
