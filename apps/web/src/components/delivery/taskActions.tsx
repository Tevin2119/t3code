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
  deliver: "Start delivery",
  close: "Close",
  publish: "Publish",
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
  approve:
    "Recorded against the commit that was tested. Where publishing is on, that commit is then pushed and one pull request opened. Nothing is merged.",
  reject: "Sent back with what is to be redone. The task is triaged and built again.",
  deliver:
    "The plan is built as it was agreed. It is not made again. The plan and what you said go into the task, and it then goes through build, checks, review and QA to your decision.",
  close: "Nothing more is done for it. What was said and found is kept.",
  publish:
    "Pushes the approved commit to its own branch and opens one pull request for it, or finds the one already open. Nothing is merged.",
};

/** What an action is called on this task. On a part of a split task, approving is a review. */
export function actionLabel(
  action: string,
  card: Pick<DeliveryCard, "partOf" | "publication"> | null,
): string {
  if (action === "publish" && card?.publication?.state === "failed") return "Try publishing again";
  if (card?.partOf && action === "approve") return "Mark part as reviewed";
  if (card?.partOf && action === "reject") return "Send part back";
  return ACTION_LABEL[action] ?? action;
}

/** What an action does, said for this task. */
export function actionHelp(action: string, card: Pick<DeliveryCard, "partOf"> | null): string {
  if (card?.partOf && action === "approve")
    return `Records that you reviewed this part as it stands. It does not approve the whole, #${card.partOf.number}, which is decided on its own.`;
  if (card?.partOf && action === "reject")
    return `Sends this part back to be built again. The whole, #${card.partOf.number}, is put together and tested again after it.`;
  return ACTION_HELP[action] ?? "";
}

type Target = Pick<
  DeliveryCard,
  "id" | "title" | "number" | "run" | "partOf" | "parts" | "publication"
>;
type Decision = { readonly card: Target; readonly decision: "approve" | "reject" | "publish" };

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
      // A decision, and publishing what was approved, each need a person's name and the key.
      if (action === "approve" || action === "reject" || action === "publish") {
        setProblem(null);
        setDecision({ card, decision: action });
        return;
      }
      if (action === "submit") void send(`/api/tasks/${card.id}/submit`, { by: person });
      else if (action === "deliver" || action === "close") {
        void send(`/api/tasks/${card.id}/control`, { action, by: person });
      } else if (action === "discard") {
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
          decision.decision === "publish"
            ? send(`/api/tasks/${decision.card.id}/publish`, { by: input.actor, key: input.key })
            : decision.card.run
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
  const publishing = decision === "publish";
  const whole = card.partOf;
  const parts = card.parts.length;
  const verb = publishing
    ? card.publication?.state === "failed"
      ? "Try publishing again"
      : "Publish"
    : approving
      ? whole
        ? "Mark as reviewed"
        : "Approve"
      : "Send back";
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup data-delivery-decision={decision}>
        <DialogHeader>
          <DialogTitle>
            {verb}: #{card.number} {card.title}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3 text-sm">
          {whole ? (
            <p
              className="rounded-md border border-border bg-muted/40 p-2"
              data-delivery-decision-part
            >
              {approving
                ? `This is a part of #${whole.number} ${whole.title}. Marking it as reviewed does not approve the whole. The whole is decided on its own, when every part is built and they were tested together.`
                : `This is a part of #${whole.number} ${whole.title}. Sent back, this part is built again, and the whole is put together and tested again after it.`}
            </p>
          ) : parts > 0 ? (
            <p
              className="rounded-md border border-border bg-muted/40 p-2"
              data-delivery-decision-whole
            >
              {approving
                ? `This decides the whole, and with it each of its ${parts} parts. It can be approved only while every part is the one that was tested together and the checks of the whole passed.`
                : `This sends the whole back, and with it each of its ${parts} parts.`}
            </p>
          ) : null}
          {publishing ? (
            <p className="text-muted-foreground" data-delivery-decision-publish>
              Pushes the approved commit
              {card.run?.candidate ? ` ${card.run.candidate.slice(0, 10)}` : ""} to its own branch
              and opens one pull request for it, or finds the one already open. It is checked again
              first: the approval must still stand for that commit and every check must have passed.
              Nothing is merged; that is done on the repository host. The approval key is shown on
              the terminal the engine was started from, and is not stored here.
            </p>
          ) : (
            <p className="text-muted-foreground">
              A decision is recorded against the commit that was tested
              {card.run?.candidate ? ` (${card.run.candidate.slice(0, 10)})` : ""}. Approving is not
              merging. Where publishing is on, the approved commit is then pushed and one pull
              request opened for review. The approval key is shown on the terminal the engine was
              started from, and is not stored here.
            </p>
          )}
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
          {approving || publishing ? null : (
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
            disabled={
              props.busy ||
              !actor.trim() ||
              !approvalKey ||
              (!approving && !publishing && !notes.trim())
            }
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
            {verb}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
