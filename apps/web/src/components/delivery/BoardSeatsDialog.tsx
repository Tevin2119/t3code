import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  draftAgainstRead,
  parseBoardSeats,
  seatSettingsToSend,
  withFallbacks,
  type SeatChoice,
  type SeatFallback,
} from "../../lib/delivery";
import {
  useDeliveryAct,
  useDeliveryRead,
  usePersonName,
  withSeatChoice,
} from "../../state/delivery";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Behind } from "./Behind";
import { FallbacksEditor } from "./FallbacksEditor";
import { SeatSettingsPanel } from "./SeatSettingsPanel";
import { TrackRecord } from "./TrackRecord";

type Chosen = Readonly<Record<string, Readonly<Record<string, SeatChoice>>>>;
type Fallbacks = Readonly<
  Record<string, Readonly<Record<string, ReadonlyArray<SeatFallback> | null>>>
>;

/**
 * What the seats of each team run on for the tasks of one board, laid over
 * the team's defaults. A task can still set its own. Saved, it applies to runs
 * admitted from then on; a run that has started keeps what it started with.
 */
export function BoardSeatsDialog(props: {
  readonly environmentId: EnvironmentId | null;
  readonly board: { readonly id: string; readonly title: string };
  readonly onClose: () => void;
}) {
  const person = usePersonName();
  const path = `/api/boards/${props.board.id}/seats`;
  const read = useDeliveryRead(props.environmentId, path);
  const teams = useMemo(() => parseBoardSeats(read.body), [read.body]);
  const act = useDeliveryAct(props.environmentId, "board seats");
  const [team, setTeam] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [fallbacks, setFallbacks] = useState<Fallbacks | null>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);
  const [said, setSaid] = useState<string | null>(null);
  const [showRecord, setShowRecord] = useState(false);
  // The revision the person's changes were made against, kept as long as the changes are.
  const [base, setBase] = useState<number | null>(null);
  // The form as the engine answered the last save, while the form still shows it.
  const [answered, setAnswered] = useState<string | null>(null);
  // The form as it stands, for a save's answer to tell whether the person changed it meanwhile.
  const snapshot = JSON.stringify([chosen, fallbacks]);
  const now = useRef(snapshot);
  useEffect(() => {
    now.current = snapshot;
  }, [snapshot]);
  const readRevision = teams[0]?.revision ?? 0;
  const standing = draftAgainstRead({ base, readRevision, asSaved: snapshot === answered });
  const showRead = () => {
    setBase(null);
    setAnswered(null);
    setChosen(null);
    setFallbacks(null);
  };
  if (standing === "take-read") showRead();
  // A first change is made against the reading on screen.
  const pin = () => setBase((was) => was ?? readRevision);

  // What the board has saved is what the form starts from, until the person changes something.
  const current: Chosen =
    chosen ??
    Object.fromEntries(
      teams.map((row) => [
        row.team,
        Object.fromEntries(row.settings.map((item) => [item.seat, item.board])),
      ]),
    );
  const currentFallbacks: Fallbacks =
    fallbacks ??
    Object.fromEntries(
      teams.map((row) => [
        row.team,
        Object.fromEntries(row.settings.map((item) => [item.seat, item.boardFallbacks])),
      ]),
    );
  const shown = teams.find((row) => row.team === team) ?? teams[0] ?? null;

  const save = async () => {
    setBusy(true);
    setProblems([]);
    setSaid(null);
    const seats = Object.fromEntries(
      teams.map((row) => [
        row.team,
        withFallbacks(
          seatSettingsToSend(row.settings, current[row.team] ?? {}, "now"),
          currentFallbacks[row.team] ?? {},
        ),
      ]),
    );
    // Saved over the revision the changes were made against: if another window saved since, it is refused.
    const pressed = now.current;
    const result = await act(path, { seats, by: person, revision: base ?? readRevision });
    setBusy(false);
    if (!result.ok) {
      // Refused: the changes stay, with their revision, to be put right or set aside. A newer
      // reading shows as one the changes are behind.
      setProblems(result.problems.length > 0 ? result.problems : [result.why]);
      read.refresh();
      return;
    }
    const body = result.body as { readonly note?: unknown } | null;
    setSaid(typeof body?.note === "string" ? body.note : "Saved.");
    // The form shows what was saved, from the answer, until the next read: never the read from before.
    const saved = parseBoardSeats(result.body);
    // An answer that cannot be read leaves the form to the next read, never empty; a change made
    // meanwhile stays, against the revision it was made on.
    if (saved.length === 0) {
      if (now.current === pressed) showRead();
      read.refresh();
      return;
    }
    const nextChosen = Object.fromEntries(
      saved.map((row) => [
        row.team,
        Object.fromEntries(row.settings.map((item) => [item.seat, item.board])),
      ]),
    );
    const nextFallbacks = Object.fromEntries(
      saved.map((row) => [
        row.team,
        Object.fromEntries(row.settings.map((item) => [item.seat, item.boardFallbacks])),
      ]),
    );
    // A change made while the save was out is the person's, and is kept over the save's answer.
    // Either way the form now stands on the saved revision.
    if (now.current === pressed) {
      setChosen(nextChosen);
      setFallbacks(nextFallbacks);
      setAnswered(JSON.stringify([nextChosen, nextFallbacks]));
    } else setAnswered(null);
    setBase(saved[0]?.revision ?? 0);
    read.refresh();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup className="max-w-3xl" data-board-seats>
        <DialogHeader>
          <DialogTitle>Seats on {props.board.title}</DialogTitle>
          <DialogDescription>
            What each seat runs on for the tasks of this board. What is left alone runs as the
            team's defaults; a task can still set its own.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3 text-sm">
          {read.error ? (
            <p className="text-warning">Delivery engine not reachable. {read.error}</p>
          ) : null}
          {teams.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Team">
              {teams.map((row) => (
                <Button
                  key={row.team}
                  size="xs"
                  role="tab"
                  aria-selected={row.team === shown?.team}
                  variant={row.team === shown?.team ? "secondary" : "ghost"}
                  onClick={() => setTeam(row.team)}
                >
                  {row.team}
                </Button>
              ))}
            </div>
          ) : null}
          {shown ? (
            <>
              <SeatSettingsPanel
                environmentId={props.environmentId}
                settings={shown.settings}
                chosen={current[shown.team] ?? {}}
                over="task"
                onChange={(seat, choice) => {
                  pin();
                  setChosen({
                    ...current,
                    [shown.team]: withSeatChoice(current[shown.team] ?? {}, seat, choice),
                  });
                }}
                renderExtra={(item) => (
                  <FallbacksEditor
                    environmentId={props.environmentId}
                    item={item}
                    value={currentFallbacks[shown.team]?.[item.seat] ?? null}
                    inherited={item.fallbackChain}
                    inheritedLabel="Team default"
                    onChange={(next) => {
                      pin();
                      setFallbacks({
                        ...currentFallbacks,
                        [shown.team]: { ...currentFallbacks[shown.team], [item.seat]: next },
                      });
                    }}
                  />
                )}
              />
              <section className="flex flex-col gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  className="self-start"
                  onClick={() => setShowRecord((open) => !open)}
                  data-board-seats-record
                >
                  {showRecord ? "Hide the track record" : `Track record of ${shown.team}`}
                </Button>
                {showRecord ? (
                  <TrackRecord environmentId={props.environmentId} team={shown.team} />
                ) : null}
              </section>
            </>
          ) : read.error ? null : (
            <p className="text-xs text-muted-foreground">Reading the board.</p>
          )}
          {problems.length > 0 ? (
            <ul className="list-disc pl-5 text-xs text-warning" data-delivery-problem>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
          {said ? <p className="text-xs text-muted-foreground">{said}</p> : null}
          {standing === "behind" ? (
            <Behind revision={readRevision} base={base ?? 0} onShowRead={showRead} />
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            Close
          </Button>
          <Button
            disabled={busy || teams.length === 0 || standing === "behind"}
            onClick={() => void save()}
            data-board-seats-save
          >
            {busy ? "Saving" : "Save for this board"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
