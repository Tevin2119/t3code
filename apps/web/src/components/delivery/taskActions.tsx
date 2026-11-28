import type { EnvironmentId } from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState } from "react";

import { minutesLeft, parseDeliveryEngineHealth } from "../../lib/deliveryEngineControl";
import type { DeliveryCard } from "../../lib/delivery";
import { boardLaneOf } from "../../lib/boardLanes";
import {
  ACTION_LABEL,
  CLOSE_REASON_LIMIT,
  closeKindOf,
  isCloseReasonRefusal,
  LANE_TITLE,
  moveIntent,
} from "../../lib/deliveryBoard";

import {
  useBoardStore,
  useDeliveryAct,
  useDeliveryRead,
  useMinuteClock,
  usePersonName,
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
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { reviewedAsPart, wholeName } from "./partOf.logic";

const ACTION_HELP: Record<string, string> = {
  "accept-artifacts":
    "Accepts the exact non-code deliverables that were reviewed. Nothing is published or submitted for you.",
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
  first:
    "Its seats take the next free slots, before other tasks. Nothing is skipped: it waits its turn for memory and limits like any task, but goes first in the queue.",
  "not-first": "It goes back to waiting its turn with the rest.",
};

/** What an action is called on this task. On a part of a split task, approving is a review. */
export function actionLabel(
  action: string,
  card: Pick<DeliveryCard, "partOf" | "publication"> | null,
): string {
  if (action === "publish" && card?.publication?.state === "failed") return "Try publishing again";
  if (reviewedAsPart(card) && action === "approve") return "Mark part as reviewed";
  if (reviewedAsPart(card) && action === "reject") return "Send part back";
  return ACTION_LABEL[action] ?? action;
}

/** What an action does, said for this task. */
export function actionHelp(action: string, card: Pick<DeliveryCard, "partOf"> | null): string {
  if (!reviewedAsPart(card) || !card?.partOf) return ACTION_HELP[action] ?? "";
  const name = wholeName(card.partOf);
  const whole = name === null ? "The whole" : `The whole, ${name},`;
  if (action === "approve")
    return `Records that you reviewed this part as it stands. It does not approve the whole${name === null ? "" : `, ${name}`}, which is decided on its own.`;
  if (action === "reject")
    return `Sends this part back to be built again. ${whole} is put together and tested again after it.`;
  return ACTION_HELP[action] ?? "";
}

type Target = Pick<
  DeliveryCard,
  "id" | "title" | "number" | "run" | "partOf" | "parts" | "publication" | "state" | "flow"
>;
type Decision = {
  readonly card: Target;
  readonly decision: "approve" | "reject" | "publish" | "accept-artifacts";
};
/** Steps that end or redo work: a drop on a column asks before taking them. */
const ASKED_FIRST = new Set(["close", "deliver", "retriage"]);
type Confirming = { readonly card: Target; readonly action: string; readonly lane: string };

/**
 * What a person may ask the engine to do with a task. Every one of these is
 * a request: the engine checks it, and its reason is shown when it refuses.
 */
export function useTaskActions(
  environmentId: EnvironmentId | null,
  options: {
    readonly onDone: () => void;
    readonly onDiscarded?: ((id: string) => void) | undefined;
    /** What the actions are for, such as the open task: a new one starts with nothing pending. */
    readonly scope?: string | undefined;
  },
) {
  const { scope } = options;
  const person = usePersonName();
  const act = useDeliveryAct(environmentId, "task action");
  const [decision, setDecision] = useState<Decision | null>(null);
  const health = useDeliveryRead(
    environmentId,
    "/api/health",
    decision !== null ? { pollMs: 5000 } : {},
  );
  const { refresh: refreshHealth } = health;
  const [requireKey, setRequireKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [closing, setClosing] = useState<Target | null>(null);
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    setDecision(null);
    setConfirming(null);
    setClosing(null);
    setRequireKey(false);
    setBusy(false);
    setProblem(null);
  }
  // What is open now, for an answer that returns after a switch: it is not the new task's.
  const currentScope = useRef(scope);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an answer arriving after a task switch is checked against the task open now
  useLayoutEffect(() => {
    currentScope.current = scope;
  }, [scope]);
  const { onDone, onDiscarded } = options;
  // One request at a time. A second press while one is out is dropped, not queued: the state it
  // was pressed against may be gone by the time the first returns. A lost answer is not sent again.
  const inFlight = useRef(false);

  const sendDecision = async (path: string, body: Record<string, unknown>) => {
    if (inFlight.current) {
      setProblem("Another step is being sent. Wait for it, then try again.");
      return { ok: false, current: true, status: null, why: null };
    }
    const sentFor = scope;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    const result = await act(path, body);
    const signoff = path.endsWith("/decide") || path.endsWith("/publish");
    if (signoff || Object.hasOwn(body, "key")) refreshHealth();
    inFlight.current = false;
    setBusy(false);
    onDone();
    // Another task opened meanwhile: its answer, a refusal included, is not shown on that one.
    if (currentScope.current !== sentFor)
      return { ok: result.ok, current: false, status: null, why: null };
    if (!result.ok) {
      setProblem(result.why);
      return { ok: false, current: true, status: result.status, why: result.why };
    }
    return { ok: true, current: true, status: null, why: null };
  };

  const send = async (path: string, body: Record<string, unknown>) =>
    (await sendDecision(path, body)).ok;
  const decide = async (path: string, body: Record<string, unknown>) => {
    const result = await sendDecision(path, body);
    if (!result.ok && result.status === 403 && !Object.hasOwn(body, "key")) setRequireKey(true);
    return result.ok;
  };

  const openClose = (card: Target) => {
    setProblem(null);
    setClosing(card);
  };

  const closeWithReason = async (card: Target, reason: string) => {
    const result = await sendDecision(`/api/tasks/${card.id}/control`, {
      action: "close",
      reason,
      by: person,
    });
    if (!result.current) return;
    if (result.ok) return setClosing(null);
    // The dialog stays open with the reason, so it can be changed and sent again.
    setProblem(null);
    toastManager.add({ type: "error", title: "The task was not closed", description: result.why });
  };

  const run = (card: Target, action: string) => {
    // A decision, and publishing what was approved, each need a person's name and the key.
    if (
      action === "approve" ||
      action === "reject" ||
      action === "publish" ||
      action === "accept-artifacts"
    ) {
      setProblem(null);
      setRequireKey(false);
      refreshHealth();
      setDecision({ card, decision: action });
      return;
    }
    if (action === "close") {
      // Work closed before it is done needs a reason, so it is asked for before anything is sent.
      if (closeKindOf(card) === "unfinished") return openClose(card);
      void sendDecision(`/api/tasks/${card.id}/control`, { action, by: person }).then((result) => {
        if (result.why !== null && isCloseReasonRefusal(result.why)) openClose(card);
      });
    } else if (action === "submit") void send(`/api/tasks/${card.id}/submit`, { by: person });
    else if (action === "deliver") {
      void send(`/api/tasks/${card.id}/control`, { action, by: person });
    } else if (action === "discard") {
      void sendDecision(`/api/tasks/${card.id}/discard`, {}).then(
        (result) => result.ok && result.current && onDiscarded?.(card.id),
      );
    } else if (action === "first" || action === "not-first") {
      void send(`/api/tasks/${card.id}/first`, { on: action === "first", by: person });
    } else if (action === "stop") {
      if (card.run) void send(`/api/runs/${card.run.id}/stop`, {});
    } else void send(`/api/tasks/${card.id}/control`, { action, by: person });
  };

  const move = (card: Pick<DeliveryCard, "id" | "lane">, lane: string, before: string | null) =>
    // Where the card was seen: if it stands elsewhere now, the engine refuses the move.
    send(`/api/tasks/${card.id}/move`, { lane, before, by: person, seen: card.lane });

  /**
   * A card taken to a column, by a drop or by choosing the column. A column a step leads to is
   * reached by that step, asked for as its button asks; one no step leads to is refused with
   * the reason, and the card stays where it was.
   */
  const moveTo = (
    card: Target & Pick<DeliveryCard, "lane" | "actions">,
    lane: string,
    before: string | null,
  ) => {
    const intent = moveIntent(card, lane);
    if (intent.kind === "move") return void move(card, lane, before);
    if (intent.kind === "refused") return setProblem(intent.why);
    // The reason dialog is itself the confirmation.
    if (intent.action === "close" && closeKindOf(card) === "unfinished") return openClose(card);
    if (ASKED_FIRST.has(intent.action)) {
      setProblem(null);
      setConfirming({ card, action: intent.action, lane });
      return;
    }
    run(card, intent.action);
  };

  return {
    busy,
    problem,
    clearProblem: () => setProblem(null),
    run,
    move,
    moveTo,
    dialog: closing ? (
      <CloseReasonDialog
        card={closing}
        busy={busy}
        onCancel={() => setClosing(null)}
        onClose={(reason) => void closeWithReason(closing, reason)}
      />
    ) : confirming ? (
      <Dialog open onOpenChange={(open) => !open && !busy && setConfirming(null)}>
        <DialogPopup className="max-w-md" data-delivery-move-confirm={confirming.action}>
          <DialogHeader>
            <DialogTitle>
              {actionLabel(confirming.action, confirming.card)}: #{confirming.card.number}{" "}
              {confirming.card.title}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-6 text-sm">
              <p>
                Moving it to {LANE_TITLE[boardLaneOf(confirming.lane)] ?? confirming.lane} means
                this step. {actionHelp(confirming.action, confirming.card)}
              </p>
              {problem ? (
                <p className="text-warning" data-delivery-problem>
                  {problem}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(null)}>
              Leave it where it is
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                const { card, action } = confirming;
                setConfirming(null);
                run(card, action);
              }}
              data-delivery-move-confirm-do
            >
              {actionLabel(confirming.action, confirming.card)}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    ) : decision ? (
      <DecisionDialog
        decision={decision}
        healthBody={!health.error ? health.body : null}
        requireKey={requireKey}
        busy={busy}
        problem={problem}
        onClose={() => setDecision(null)}
        onDecide={(input) =>
          decision.decision === "accept-artifacts"
            ? decide(`/api/tasks/${decision.card.id}/control`, {
                action: "accept-artifacts",
                run: decision.card.run?.id,
                by: input.actor,
                key: input.key,
              })
            : decision.decision === "publish"
              ? decide(`/api/tasks/${decision.card.id}/publish`, {
                  by: input.actor,
                  ...(input.key === undefined ? {} : { key: input.key }),
                  // The commit the dialog names: if another is approved now, nothing is pushed.
                  ...(decision.card.run?.candidate
                    ? { candidate: decision.card.run.candidate }
                    : {}),
                })
              : decision.card.run
                ? decide(`/api/runs/${decision.card.run.id}/decide`, {
                    decision: decision.decision,
                    // The candidate the person was shown: if another is waiting now, nothing is decided.
                    ...(decision.card.run.candidate
                      ? { candidate: decision.card.run.candidate }
                      : {}),
                    ...input,
                  })
                : Promise.resolve(false)
        }
      />
    ) : null,
  };
}

function CloseReasonDialog(props: {
  readonly card: Target;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onClose: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  return (
    <Dialog open onOpenChange={(open) => !open && !props.busy && props.onCancel()}>
      <DialogPopup className="max-w-md" data-delivery-close-reason>
        <DialogHeader>
          <DialogTitle>
            Close without it being done: #{props.card.number} {props.card.title}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-6 text-sm">
            <p className="text-muted-foreground">
              Nothing more is done for it. What was said and found is kept, along with its branch.
              Say why it is closed; the reason is kept with the task.
            </p>
            <Textarea
              aria-label="Why it is closed"
              placeholder="Why it is closed"
              maxLength={CLOSE_REASON_LIMIT}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={props.busy} onClick={props.onCancel}>
            Keep it open
          </Button>
          <Button
            variant="destructive"
            disabled={props.busy || !trimmed}
            onClick={() => props.onClose(trimmed)}
          >
            Close task
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DecisionDialog(props: {
  readonly decision: Decision;
  readonly healthBody: unknown;
  readonly requireKey: boolean;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onClose: () => void;
  readonly onDecide: (input: {
    readonly actor: string;
    readonly key?: string;
    readonly notes?: string;
  }) => Promise<boolean>;
}) {
  const person = usePersonName();
  const now = useMinuteClock();
  const setPerson = useBoardStore((state) => state.setPerson);
  const [actor, setActor] = useState(person);
  const window = parseDeliveryEngineHealth(props.healthBody, actor.trim()).approvalWindow;
  const windowUntil =
    !props.requireKey &&
    props.decision.decision !== "accept-artifacts" &&
    window?.open &&
    window.by === actor.trim()
      ? window.until
      : null;
  const windowOpen = windowUntil !== null && minutesLeft(windowUntil, now) > 0;
  const [approvalKey, setApprovalKey] = useState("");
  const [notes, setNotes] = useState("");
  const { card, decision } = props.decision;
  const accepting = decision === "accept-artifacts";
  const approving = decision === "approve" || accepting;
  const publishing = decision === "publish";
  const whole = reviewedAsPart(card) ? card.partOf : null;
  const wholeNamed = whole ? wholeName(whole) : null;
  const partOfWords = wholeNamed
    ? `This is a part of ${wholeNamed}.`
    : "This is a part of a larger task.";
  const parts = card.parts.length;
  const verb = accepting
    ? "Accept deliverables"
    : publishing
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
        <DialogPanel>
          <div className="flex flex-col gap-7 text-sm">
            {whole ? (
              <p
                className="rounded-md border border-border bg-muted/40 p-2"
                data-delivery-decision-part
              >
                {approving
                  ? `${partOfWords} Marking it as reviewed does not approve the whole. The whole is decided on its own, when every part is built and they were tested together.`
                  : `${partOfWords} Sent back, this part is built again, and the whole is put together and tested again after it.`}
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
            {accepting ? (
              <p className="text-muted-foreground">
                Records your acceptance against the exact artifact hashes reviewed by the team. No
                software pull request is opened and nothing is submitted to a course or publisher.
                Use this environment's approval passphrase. T3 does not save it.
              </p>
            ) : publishing ? (
              <p className="text-muted-foreground" data-delivery-decision-publish>
                Pushes the approved commit
                {card.run?.candidate ? ` ${card.run.candidate.slice(0, 10)}` : ""} to its own branch
                and opens one pull request for it, or finds the one already open. It is checked
                again first: the approval must still stand for that commit and every check must have
                passed. Nothing is merged; that is done on the repository host.{" "}
                {windowOpen
                  ? ""
                  : "Use this environment's approval passphrase, or its terminal key if no passphrase is set. T3 does not save it."}
              </p>
            ) : (
              <p className="text-muted-foreground">
                A decision is recorded against the commit that was tested
                {card.run?.candidate ? ` (${card.run.candidate.slice(0, 10)})` : ""}. Approving is
                not merging. Where publishing is on, the approved commit is then pushed and one pull
                request opened for review.{" "}
                {windowOpen
                  ? ""
                  : "Use this environment's approval passphrase, or its terminal key if no passphrase is set. T3 does not save it."}
              </p>
            )}
            <Input
              aria-label="Your name"
              placeholder="Your name"
              value={actor}
              onChange={(event) => setActor(event.target.value)}
            />
            {windowOpen ? (
              <p data-approvals-open>
                Approvals are open; no passphrase needed. {minutesLeft(windowUntil, now)} minutes
                left.
              </p>
            ) : (
              <Input
                aria-label="Approval passphrase or terminal key"
                placeholder="Approval passphrase or terminal key"
                name="delivery-approval"
                type="password"
                autoComplete="current-password"
                value={approvalKey}
                onChange={(event) => setApprovalKey(event.target.value)}
              />
            )}
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
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              props.busy ||
              !actor.trim() ||
              (!windowOpen && !approvalKey) ||
              (!approving && !publishing && !notes.trim())
            }
            onClick={() => {
              if (!person) setPerson(actor.trim());
              void props
                .onDecide({
                  actor: actor.trim(),
                  ...(windowOpen ? {} : { key: approvalKey }),
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
