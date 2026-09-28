import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { parseTeamDefaults, seatSettingsToSend, type SeatChoice } from "../../lib/delivery";
import { describeSeatValues, seatValues, sharePercentages } from "../../lib/deliverySeats";
import {
  useDeliveryAct,
  useDeliveryRead,
  usePersonName,
  withSeatChoice,
} from "../../state/delivery";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SeatSettingsPanel } from "./SeatSettingsPanel";

/**
 * The defaults of a team: what each seat runs on unless a task says
 * otherwise, and how the builds are shared between the seats that build.
 * Saved, they apply to runs admitted from then on. A run that has started
 * keeps what it started with.
 */
export function TeamDefaultsDialog(props: {
  readonly environmentId: EnvironmentId | null;
  readonly team: string;
  readonly onClose: () => void;
  readonly onSaved?: (() => void) | undefined;
}) {
  const person = usePersonName();
  const read = useDeliveryRead(props.environmentId, `/api/teams/${props.team}/defaults`);
  const current = useMemo(() => parseTeamDefaults(read.body), [read.body]);
  const act = useDeliveryAct(props.environmentId, "team defaults");
  const [seats, setSeats] = useState<Record<string, SeatChoice> | null>(null);
  const [shares, setShares] = useState<Record<string, string> | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);
  const [said, setSaid] = useState<string | null>(null);

  const team = current?.team ?? null;
  // What is saved is what the form starts from, until the person changes something.
  const chosen =
    seats ?? Object.fromEntries((team?.settings ?? []).map((item) => [item.seat, item.saved]));
  const weights =
    shares ??
    Object.fromEntries(
      Object.entries(team?.workload.build ?? {}).map(([seat, share]) => [seat, String(share)]),
    );
  const numbers = Object.fromEntries(
    Object.entries(weights).map(([seat, share]) => [seat, Number(share)]),
  );
  const percentages = sharePercentages(numbers);
  const sharesAreNumbers = Object.values(numbers).every(
    (share) => Number.isFinite(share) && share >= 0 && share <= 100,
  );

  const save = async () => {
    if (!team) return;
    setBusy(true);
    setProblems([]);
    setSaid(null);
    const result = await act(`/api/teams/${props.team}/defaults`, {
      seats: seatSettingsToSend(team.settings, chosen, "defined"),
      // Shares that are what the team defines are not saved over it.
      workload: Object.entries(numbers).some(
        ([seat, share]) => share !== team.workload.defined[seat],
      )
        ? { build: numbers }
        : {},
      by: person,
      note: note.trim() || null,
    });
    setBusy(false);
    if (!result.ok) {
      setProblems(result.problems.length > 0 ? result.problems : [result.why]);
      return;
    }
    setSaid(parseTeamDefaults(result.body)?.note ?? "Saved.");
    setSeats(null);
    setShares(null);
    setNote("");
    read.refresh();
    props.onSaved?.();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-3xl" data-delivery-team-defaults>
        <DialogHeader>
          <DialogTitle>Defaults of team {props.team}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto text-sm">
          <p className="text-xs text-muted-foreground">
            What each seat runs on unless a task sets its own. A seat keeps its role and its rules;
            the harness and the model it runs on are chosen here. The QA gate has to keep{" "}
            {team?.qaGate?.minimum ?? 2} providers that did not build the change, and the engine
            refuses defaults that would leave it with fewer.
          </p>
          {read.error ? (
            <p className="text-warning">Delivery engine not reachable. {read.error}</p>
          ) : null}
          {team ? (
            <>
              <section>
                <h3 className="pb-1 text-xs font-medium text-muted-foreground">Seats</h3>
                <SeatSettingsPanel
                  environmentId={props.environmentId}
                  settings={team.settings}
                  chosen={chosen}
                  over="defaults"
                  shares={percentages}
                  onChange={(seat, choice) => setSeats(withSeatChoice(chosen, seat, choice))}
                />
              </section>

              {Object.keys(weights).length > 1 ? (
                <section data-delivery-workload>
                  <h3 className="pb-1 text-xs font-medium text-muted-foreground">
                    Who builds, and how much
                  </h3>
                  <p className="pb-2 text-xs text-muted-foreground">
                    Each run is built by one of these seats. The shares are weights: the seat
                    furthest behind its share builds next. A seat that is waiting after a rate
                    limit, is not installed, or may only read is passed over, and the others build
                    in its place.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {Object.entries(weights).map(([seat, share]) => {
                      const item = team.settings.find((candidate) => candidate.seat === seat);
                      return (
                        <label key={seat} className="flex items-center gap-2 text-xs">
                          <span>{item?.title ?? seat}</span>
                          <Input
                            aria-label={`Share of the builds for ${item?.title ?? seat}`}
                            className="h-7 w-16"
                            inputMode="decimal"
                            value={share}
                            onChange={(event) =>
                              setShares({ ...weights, [seat]: event.target.value })
                            }
                          />
                          <span className="text-muted-foreground">{percentages[seat] ?? 0}%</span>
                        </label>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              <Input
                aria-label="Why the defaults are changed"
                placeholder="Why the defaults are changed (kept with the saving)"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />

              {problems.length > 0 ? (
                <ul className="list-disc pl-5 text-xs text-warning" data-delivery-problem>
                  {problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              ) : null}
              {said ? <p className="text-xs text-muted-foreground">{said}</p> : null}

              <section>
                <h3 className="pb-1 text-xs font-medium text-muted-foreground">
                  Saved before
                  {team.defaults.revision > 0
                    ? `, now at revision ${team.defaults.revision}`
                    : ": never. The team runs as it is defined."}
                </h3>
                <ul className="flex flex-col gap-1 text-xs">
                  {current?.history.map((row) => (
                    <li key={row.revision} className="rounded border border-border px-2 py-1">
                      <span className="font-mono text-[10px] text-muted-foreground">
                        r{row.revision}, {row.by}, {row.at}
                      </span>
                      {row.note ? <span className="block">{row.note}</span> : null}
                      <span className="block text-muted-foreground">
                        {Object.entries(row.seats)
                          .map(([seat, choice]) => {
                            const item = team.settings.find((candidate) => candidate.seat === seat);
                            return `${item?.title ?? seat}: ${describeSeatValues(
                              seatValues(
                                item?.defined ?? {
                                  harness: null,
                                  model: null,
                                  reasoning: null,
                                  access: null,
                                },
                                choice,
                              ),
                            )}`;
                          })
                          .concat(
                            Object.keys(row.workload).length > 0
                              ? [
                                  `builds shared ${Object.entries(row.workload)
                                    .map(([seat, share]) => `${seat} ${share}`)
                                    .join(", ")}`,
                                ]
                              : [],
                          )
                          .join("; ") || "Back to what the team defines."}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          ) : read.error ? null : (
            <p className="text-xs text-muted-foreground">Reading the team.</p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Close
          </Button>
          <Button disabled={busy || !team || !sharesAreNumbers} onClick={() => void save()}>
            {busy ? "Saving" : "Save defaults"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
