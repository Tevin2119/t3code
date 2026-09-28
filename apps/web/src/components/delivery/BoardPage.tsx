import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { deliveryFailureText, parseBoard, type DeliveryCard } from "../../lib/delivery";
import {
  deliveryEnvironment,
  useDeliveryEnabled,
  useDeliveryRead,
  useStaleReading,
} from "../../state/delivery";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
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
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const ACTION_LABEL: Record<string, string> = {
  triage: "Triage",
  run: "Run",
  stop: "Stop",
  resume: "Resume",
  approve: "Approve",
  reject: "Send back",
};

type Decision = { readonly card: DeliveryCard; readonly decision: "approve" | "reject" };

function Card(props: {
  readonly card: DeliveryCard;
  readonly busy: boolean;
  readonly onAction: (card: DeliveryCard, action: string) => void;
}) {
  const { card } = props;
  return (
    <article className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5 text-xs">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 text-sm leading-snug font-medium break-words">{card.title}</h3>
        <Badge size="sm" variant="outline" className="shrink-0">
          {card.team}
        </Badge>
      </div>
      <p className="font-mono text-[10px] text-muted-foreground">
        {card.id} r{card.revision}
        {card.origin.startsWith("finding:") ? " from a finding" : ""}
      </p>
      {card.run ? (
        <p className="font-mono text-[10px] text-muted-foreground">
          {card.run.id}: {card.run.state} at {card.run.stage}
          {card.run.candidate ? `, tested ${card.run.candidate.slice(0, 10)}` : ""}
        </p>
      ) : null}
      {card.parts.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {card.parts.map((part) => (
            <li key={part.id} className="flex justify-between gap-2 text-muted-foreground">
              <span className="min-w-0 truncate">{part.title}</span>
              <span className="shrink-0 font-mono text-[10px]">{part.lane ?? "closed"}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {card.paused ? (
        <p className="text-warning">
          {card.paused.needsPerson ? "Needs a person" : "Paused"}: {card.paused.why}
          {card.paused.nextTry ? ` Next try ${card.paused.nextTry}.` : ""}
        </p>
      ) : null}
      {card.findings.all > 0 ? (
        <p className="text-muted-foreground">
          {card.findings.open} open of {card.findings.all} finding
          {card.findings.all === 1 ? "" : "s"}
          {card.followUps.length > 0 ? `, ${card.followUps.length} filed as tasks` : ""}
        </p>
      ) : null}
      {card.approvals.map((approval) => (
        <p
          key={`${approval.actor}:${approval.decision}:${approval.stands}`}
          className="text-muted-foreground"
        >
          {approval.decision} by {approval.actor}: {approval.stands ? "stands" : "no longer stands"}
        </p>
      ))}
      {card.actions.length > 0 ? (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {card.actions.map((action) => (
            <Button
              key={action}
              size="xs"
              variant={action === "approve" ? "default" : "outline"}
              disabled={props.busy}
              onClick={() => props.onAction(card, action)}
            >
              {ACTION_LABEL[action] ?? action}
            </Button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

/**
 * The delivery board. A lane is where the engine put a card: cards are not
 * dragged, and every button asks the engine, which checks the request.
 */
export function BoardPage() {
  const environmentId = usePrimaryEnvironmentId();
  const enabled = useDeliveryEnabled(environmentId);
  const [view, setView] = useState("development");
  const board = useDeliveryRead(enabled ? environmentId : null, `/api/lanes?view=${view}`, {
    pollMs: 5_000,
  });
  const parsed = useMemo(() => parseBoard(board.body), [board.body]);
  const act = useAtomCommand(deliveryEnvironment.act, {
    label: "board action",
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [actor, setActor] = useState("");
  const [approvalKey, setApprovalKey] = useState("");
  const [notes, setNotes] = useState("");
  const [filing, setFiling] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const send = async (path: string, payload: unknown) => {
    if (!environmentId) return false;
    setBusy(true);
    setProblem(null);
    const result = await act({ environmentId, input: { path: path as never, body: payload } });
    setBusy(false);
    board.refresh();
    if (result._tag === "Failure") {
      setProblem(deliveryFailureText(squashAtomCommandFailure(result)));
      return false;
    }
    return true;
  };

  const onAction = (card: DeliveryCard, action: string) => {
    if (action === "approve" || action === "reject") {
      setDecision({ card, decision: action });
      setNotes("");
      return;
    }
    if (action === "triage") void send(`/api/tasks/${card.id}/triage`, {});
    else if (action === "run") void send(`/api/tasks/${card.id}/run`, {});
    else if (action === "stop" && card.run) void send(`/api/runs/${card.run.id}/stop`, {});
    else if (action === "resume") void send("/api/resume", {});
  };

  const stale = useStaleReading(board.readAt);

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 py-2">
            <h1 className="text-sm font-medium">Board</h1>
            <Select value={view} onValueChange={(value) => setView(String(value))}>
              <SelectTrigger
                aria-label="Board view"
                size="compact"
                variant="ghost"
                className="w-auto min-w-0"
              >
                <SelectValue>
                  {parsed?.views.find((item) => item.id === view)?.title ?? view}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {(parsed?.views ?? [{ id: "development", title: "Development" }]).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <span className="font-mono text-[10px] text-muted-foreground">
              {board.readAt
                ? `read ${board.readAt}${stale ? " (stale)" : ""}`
                : enabled
                  ? "not read yet"
                  : ""}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Link to="/orchestrator" className="text-xs text-muted-foreground underline">
                Orchestrator
              </Link>
              <Button
                size="xs"
                variant="outline"
                disabled={!enabled}
                onClick={() => setFiling(true)}
              >
                New task
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh board"
                onClick={board.refresh}
              >
                <RefreshIcon className="size-3.5" refreshing={board.isPending} />
              </Button>
            </div>
          </div>
        </WorkspacePageHeader>

        {!enabled ? (
          <p className="p-6 text-sm text-muted-foreground">
            Delivery is turned off for this environment. Turn it on in the server settings to see
            the board.
          </p>
        ) : board.error ? (
          <p className="p-6 text-sm text-warning">
            Delivery engine not reachable. {board.error} Nothing shown here is current.
          </p>
        ) : (
          <>
            {problem ? <p className="px-5 pt-3 text-sm text-warning">{problem}</p> : null}
            {parsed?.note ? (
              <p className="px-5 pt-3 text-sm text-muted-foreground">{parsed.note}</p>
            ) : null}
            {parsed?.notices.map((notice) => (
              <p key={notice.key} className="px-5 pt-3 text-sm text-warning">
                {notice.text} Seen {notice.count} time{notice.count === 1 ? "" : "s"}.
              </p>
            ))}
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex min-w-max gap-3 p-5">
                {(parsed?.lanes ?? []).map((lane) => (
                  <section key={lane.lane} className="flex w-64 shrink-0 flex-col gap-2">
                    <h2 className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                      <span>{lane.title}</span>
                      <span className="font-mono">{lane.cards.length}</span>
                    </h2>
                    {lane.cards.map((card) => (
                      <Card key={card.id} card={card} busy={busy} onAction={onAction} />
                    ))}
                  </section>
                ))}
              </div>
            </ScrollArea>
          </>
        )}
      </div>

      <Dialog open={decision !== null} onOpenChange={(open) => !open && setDecision(null)}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {decision?.decision === "approve" ? "Approve" : "Send back"}: {decision?.card.title}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">
              A decision is recorded against the commit that was tested
              {decision?.card.run?.candidate
                ? ` (${decision.card.run.candidate.slice(0, 10)})`
                : ""}
              . Nothing is merged. The approval key is shown on the terminal the engine was started
              from, and is not stored here.
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
            {decision?.decision === "reject" ? (
              <Textarea
                aria-label="What to redo"
                placeholder="What to redo"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            ) : null}
            {problem ? <p className="text-warning">{problem}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecision(null)}>
              Cancel
            </Button>
            <Button
              disabled={
                busy ||
                !actor.trim() ||
                !approvalKey ||
                (decision?.decision === "reject" && !notes.trim())
              }
              onClick={() => {
                if (!decision?.card.run) return;
                void send(`/api/runs/${decision.card.run.id}/decide`, {
                  actor: actor.trim(),
                  decision: decision.decision,
                  key: approvalKey,
                  ...(notes.trim() ? { notes: notes.trim() } : {}),
                }).then((done) => {
                  // The key is dropped after every use, whether it worked or not.
                  setApprovalKey("");
                  if (done) setDecision(null);
                });
              }}
            >
              {decision?.decision === "approve" ? "Approve" : "Send back"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog open={filing} onOpenChange={setFiling}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3 text-sm">
            <Input
              aria-label="Title"
              placeholder="Title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Textarea
              aria-label="What is asked"
              placeholder="What is asked"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <p className="text-muted-foreground">
              Filed for the Development team. It goes to triage before anything is built.
            </p>
            {problem ? <p className="text-warning">{problem}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFiling(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !title.trim() || !body.trim()}
              onClick={() => {
                void send("/api/tasks", {
                  title: title.trim(),
                  body: body.trim(),
                  team: "development",
                }).then((done) => {
                  if (!done) return;
                  setFiling(false);
                  setTitle("");
                  setBody("");
                });
              }}
            >
              File
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SidebarInset>
  );
}
