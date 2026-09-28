import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import type { DeliveryCard } from "../../lib/delivery";
import { useBoardStore, useDeliveryAct, usePersonName } from "../../state/delivery";
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
import { Textarea } from "../ui/textarea";

export const ACTION_LABEL: Record<string, string> = {
  submit: "Submit",
  discard: "Discard draft",
  pause: "Pause",
  resume: "Resume",
  stop: "Stop the running step",
  retry: "Try again",
  retriage: "Send to triage again",
  "start-anyway": "Start without waiting",
  approve: "Approve",
  reject: "Send back",
};

export const ACTION_HELP: Record<string, string> = {
  submit: "The team takes it on. It goes to triage and on from there without being asked.",
  discard: "The draft is removed. Nothing was asked of anyone.",
  pause: "Nothing more is started for this task until it is resumed. A running step is stopped.",
  resume: "The work goes on from where it stood.",
  stop: "The seat that is working is stopped. The task stays where it is.",
  retry: "The stopped step is started again.",
  retriage: "What was built so far becomes history and the task is triaged again.",
  "start-anyway": "The task stops waiting for the tasks it depends on.",
  approve: "Recorded against the commit that was tested. Nothing is merged.",
  reject: "Sent back with what is to be redone. The task is triaged and built again.",
};

type Target = Pick<DeliveryCard, "id" | "title" | "number" | "run">;
type Decision = { readonly card: Target; readonly decision: "approve" | "reject" };

/**
 * What a person may ask the engine to do with a task. Every one of these is
 * a request: the engine checks it, and its reason is shown when it refuses.
 */
export function useTaskActions(
  environmentId: EnvironmentId | null,
  options: {
    readonly onDone: () => void;
    readonly onDiscarded?: ((id: string) => void) | undefined;
  },
) {
  const person = usePersonName();
  const act = useDeliveryAct(environmentId, "task action");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const { onDone, onDiscarded } = options;

  const send = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      setBusy(true);
      setProblem(null);
      const result = await act(path, body);
      setBusy(false);
      onDone();
      if (!result.ok) {
        setProblem(result.why);
        return false;
      }
      return true;
    },
    [act, onDone],
  );

  const run = useCallback(
    (card: Target, action: string) => {
      if (action === "approve" || action === "reject") {
        setProblem(null);
        setDecision({ card, decision: action });
        return;
      }
      if (action === "submit") void send(`/api/tasks/${card.id}/submit`, { by: person });
      else if (action === "discard") {
        void send(`/api/tasks/${card.id}/discard`, {}).then(
          (done) => done && onDiscarded?.(card.id),
        );
      } else if (action === "stop") {
        if (card.run) void send(`/api/runs/${card.run.id}/stop`, {});
      } else void send(`/api/tasks/${card.id}/control`, { action, by: person });
    },
    [onDiscarded, person, send],
  );

  const move = useCallback(
    (card: Pick<DeliveryCard, "id">, lane: string, before: string | null) =>
      send(`/api/tasks/${card.id}/move`, { lane, before, by: person }),
    [person, send],
  );

  return {
    busy,
    problem,
    clearProblem: () => setProblem(null),
    run,
    move,
    dialog: decision ? (
      <DecisionDialog
        decision={decision}
        busy={busy}
        problem={problem}
        onClose={() => setDecision(null)}
        onDecide={(input) =>
          decision.card.run
            ? send(`/api/runs/${decision.card.run.id}/decide`, {
                decision: decision.decision,
                ...input,
              })
            : Promise.resolve(false)
        }
      />
    ) : null,
  };
}

function DecisionDialog(props: {
  readonly decision: Decision;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onClose: () => void;
  readonly onDecide: (input: {
    readonly actor: string;
    readonly key: string;
    readonly notes?: string;
  }) => Promise<boolean>;
}) {
  const person = usePersonName();
  const setPerson = useBoardStore((state) => state.setPerson);
  const [actor, setActor] = useState(person);
  const [approvalKey, setApprovalKey] = useState("");
  const [notes, setNotes] = useState("");
  const { card, decision } = props.decision;
  const approving = decision === "approve";
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup data-delivery-decision={decision}>
        <DialogHeader>
          <DialogTitle>
            {approving ? "Approve" : "Send back"}: #{card.number} {card.title}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            A decision is recorded against the commit that was tested
            {card.run?.candidate ? ` (${card.run.candidate.slice(0, 10)})` : ""}. Nothing is merged.
            The approval key is shown on the terminal the engine was started from, and is not stored
            here.
          </p>
          <Input
            aria-label="Your name"
            placeholder="Your name"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
          />
          <Input
            aria-label="Approval key"
            placeholder="Approval key"
            type="password"
            autoComplete="off"
            value={approvalKey}
            onChange={(event) => setApprovalKey(event.target.value)}
          />
          {approving ? null : (
            <Textarea
              aria-label="What to redo"
              placeholder="What to redo"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
          {props.problem ? (
            <p className="text-warning" data-delivery-problem>
              {props.problem}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={props.busy || !actor.trim() || !approvalKey || (!approving && !notes.trim())}
            onClick={() => {
              if (!person) setPerson(actor.trim());
              void props
                .onDecide({
                  actor: actor.trim(),
                  key: approvalKey,
                  ...(notes.trim() ? { notes: notes.trim() } : {}),
                })
                .then((done) => {
                  // The key is dropped after every use, whether it worked or not.
                  setApprovalKey("");
                  if (done) props.onClose();
                });
            }}
          >
            {approving ? "Approve" : "Send back"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
