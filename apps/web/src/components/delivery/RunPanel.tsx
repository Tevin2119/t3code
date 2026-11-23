import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { repeatKeys, type TaskView } from "../../lib/delivery";
import { harnessLabel } from "../../lib/deliverySeats";
import { useDeliveryAct, useDeliveryRead, usePersonName } from "../../state/delivery";
import ChatMarkdown from "../ChatMarkdown";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

const DOCUMENT_LABEL: Record<string, string> = {
  "PLAN.md": "Plan",
  "REVIEW.md": "Review",
  "PACK.md": "Evidence pack",
};

/**
 * The run under way, for a person following it: the documents it wrote, to read here or have
 * summarised, the instructions given to it, and a way to give one. An instruction reaches the
 * seat at work it is for, which starts its step again with it; what is asked is changed by a
 * change, which goes through triage, not here.
 */
export function RunPanel(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: TaskView;
  readonly onChanged: () => void;
}) {
  const { task } = props;
  const council = task.council;
  const person = usePersonName();
  const act = useDeliveryAct(props.environmentId, "run");
  const [reading, setReading] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [seat, setSeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  if (!council) return null;
  const steerable = ["running", "paused", "needs-decision"].includes(council.state);
  const steerKeys = repeatKeys(council.steers.map((steer) => `${steer.at}:${steer.text}`));
  const give = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const result = await act(`/api/tasks/${task.id}/steer`, {
      text: text.trim(),
      seat: seat || null,
      by: person,
    });
    setBusy(false);
    if (result.ok) {
      setText("");
      setSaid(
        "Given. It is in the history; the step starts again with it once its seats have stopped.",
      );
    } else setSaid(result.why);
    props.onChanged();
  };
  const summarise = async (name: string) => {
    setBusy(true);
    const result = await act(`/api/tasks/${task.id}/messages`, {
      kind: "message",
      text: `Summarise the ${DOCUMENT_LABEL[name] ?? name} (${name}) of run ${council.run} for me in a few lines: what it says will be done, how it will be checked, and anything I should look at.`,
      by: person,
    });
    setBusy(false);
    setSaid(result.ok ? "Asked the coordinator. The answer comes in the history." : result.why);
    props.onChanged();
  };
  return (
    <section className="flex flex-col gap-2" data-task-run-panel>
      <h3 className="text-xs font-medium text-muted-foreground">Run {council.run}</h3>
      {council.documents.length > 0 ? (
        <div className="flex flex-col gap-1" data-run-documents>
          {council.documents.map((name) => (
            <div key={name} className="flex items-center justify-between gap-2 text-xs">
              <Button
                size="xs"
                variant="outline"
                onClick={() => setReading(name)}
                data-run-document={name}
              >
                Read the {(DOCUMENT_LABEL[name] ?? name).toLowerCase()}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => void summarise(name)}
                data-run-summarise={name}
              >
                Summarise
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-2xs text-muted-foreground">
          No plan, review or evidence written yet. Each shows here once the run writes it.
        </p>
      )}
      {council.steers.length > 0 ? (
        <ul className="flex flex-col gap-1 text-2xs" data-run-steers>
          {council.steers.map((steer, index) => (
            <li key={steerKeys[index]} className="rounded border border-border px-2 py-1">
              <span className="text-muted-foreground">
                {steer.by} to {steer.seat ?? "every seat"}:{" "}
              </span>
              {steer.text}
            </li>
          ))}
        </ul>
      ) : null}
      {steerable ? (
        <div className="flex flex-col gap-1" data-run-steer>
          <Select value={seat} onValueChange={(value) => setSeat(String(value ?? ""))}>
            <SelectTrigger
              aria-label="Who the instruction is for"
              size="compact"
              variant="ghost"
              className="w-auto min-w-0 self-start"
            >
              <SelectValue>{seat ? `To ${seat}` : "To every seat"}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem value="">To every seat</SelectItem>
              {council.seats.map((item) => (
                <SelectItem key={item.seat} value={item.seat}>
                  To {item.seat} ({harnessLabel(item.harness)})
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Textarea
            aria-label="An instruction for the run"
            placeholder="Steer the work: say what to do differently from now on"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button
            size="xs"
            className="self-start"
            disabled={busy || !text.trim()}
            onClick={() => void give()}
            data-run-steer-give
          >
            Give the instruction
          </Button>
          <p className="text-3xs text-muted-foreground">
            Every seat at work stops, and the step starts again once all have ended, with the
            instruction given to the seat it names (or to all). To change what is asked, write a
            change instead: that goes through triage.
          </p>
        </div>
      ) : null}
      {said ? <p className="text-2xs text-muted-foreground">{said}</p> : null}
      {reading ? (
        <RunDocument
          environmentId={props.environmentId}
          run={council.run}
          name={reading}
          onClose={() => setReading(null)}
        />
      ) : null}
    </section>
  );
}

/** A document a run wrote (PLAN.md, REVIEW.md, PACK.md), read in a dialog. */
function RunDocument(props: {
  readonly environmentId: EnvironmentId | null;
  readonly run: string;
  readonly name: string;
  readonly onClose: () => void;
}) {
  const read = useDeliveryRead(
    props.environmentId,
    `/api/runs/${props.run}/document?name=${encodeURIComponent(props.name)}`,
  );
  const body = read.body as { readonly text?: unknown; readonly cut?: unknown } | null;
  const doc = typeof body?.text === "string" ? body.text : null;
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-3xl" data-run-document-open={props.name}>
        <DialogHeader>
          <DialogTitle>
            {DOCUMENT_LABEL[props.name] ?? props.name}, run {props.run}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4 text-sm">
            {doc !== null ? (
              <>
                <ChatMarkdown
                  text={doc}
                  cwd={undefined}
                  environmentId={props.environmentId ?? undefined}
                  parseRawHtml={false}
                  allowMedia={false}
                />
                {body?.cut === true ? (
                  <p className="pt-2 text-xs text-muted-foreground">
                    Only the first part is shown; the whole is in the run's evidence folder.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {read.error ? `It cannot be read: ${read.error}` : "Reading it."}
              </p>
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
