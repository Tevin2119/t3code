import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { DELIVERY_DEFAULT_TEAM } from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import {
  deliveryFailureText,
  parseOrchestratorThread,
  parseTeams,
  parseThreadList,
  seatSettingsToSend,
  type CouncilSeat,
  type DeliverySeat,
} from "../../lib/delivery";
import {
  deliveryEnvironment,
  useDeliveryEnabled,
  useDeliveryRead,
  useStaleReading,
  type SeatChoice,
} from "../../state/delivery";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SeatSettingsPanel } from "./SeatSettingsPanel";
import { TeamProfilePanel } from "./TeamProfilePanel";

const ACTIVITY_VARIANT: Record<string, "success" | "info" | "warning" | "secondary" | "error"> = {
  active: "info",
  queued: "warning",
  completed: "success",
  waiting: "secondary",
  unavailable: "error",
};

const KIND_LABEL: Record<string, string> = {
  question: "question about progress",
  change: "change to what is asked",
  answer: "from the engine's record",
  start: "what was asked",
};

function Roster(props: {
  readonly roster: ReadonlyArray<DeliverySeat>;
  readonly seats: ReadonlyArray<CouncilSeat>;
}) {
  return (
    <table className="w-full text-left text-xs" data-delivery-roster>
      <thead className="text-muted-foreground">
        <tr>
          <th className="py-1 pr-2 font-normal">Seat</th>
          <th className="py-1 pr-2 font-normal">Harness</th>
          <th className="py-1 font-normal">Doing</th>
        </tr>
      </thead>
      <tbody>
        {props.roster.map((seat) => {
          const live = props.seats.find((candidate) => candidate.seat === seat.seat);
          const activity = !seat.available ? "unavailable" : (live?.activity ?? "waiting");
          return (
            <tr key={seat.seat} className="border-t border-border align-top">
              <td className="py-1 pr-2">
                {seat.seat}
                <span className="block text-[10px] text-muted-foreground">
                  {seat.role}, {seat.required ? "required" : "optional"}
                </span>
              </td>
              <td className="py-1 pr-2">{seat.harness}</td>
              <td className="py-1">
                <Badge size="sm" variant={ACTIVITY_VARIANT[activity] ?? "secondary"}>
                  {activity}
                </Badge>
                <span className="block text-[10px] text-muted-foreground">
                  {!seat.available
                    ? (seat.why ?? "")
                    : live?.blockedBy
                      ? `waiting for a slot: ${live.blockedBy}`
                      : live?.verdict
                        ? `QA verdict: ${live.verdict}`
                        : live?.stage
                          ? `last at ${live.stage}`
                          : ""}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * A conversation with a team. It begins as a draft, where the team, the
 * workflow and each seat's settings are chosen and nothing runs. Started, it
 * is a task of the team. After that a message is either a question about
 * progress, which changes nothing, or a change to what is asked.
 */
export function OrchestratorPage() {
  const environmentId = usePrimaryEnvironmentId();
  const enabled = useDeliveryEnabled(environmentId);
  const active = enabled ? environmentId : null;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { thread?: string };
  const selected = search.thread ?? null;
  const select = (thread: string | null) =>
    void navigate({ to: "/orchestrator", search: thread ? { thread } : {} });

  const [team, setTeam] = useState<string>(DELIVERY_DEFAULT_TEAM);
  const [text, setText] = useState("");
  const [seats, setSeats] = useState<Record<string, SeatChoice>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [panel, setPanel] = useState<"council" | "seats" | "setup">("council");

  const teamsRead = useDeliveryRead(active, "/api/teams");
  const teams = useMemo(
    () => parseTeams(teamsRead.body).filter((item) => item.team !== "triage"),
    [teamsRead.body],
  );
  const listRead = useDeliveryRead(active, "/api/threads", { pollMs: 10_000 });
  const threads = useMemo(() => parseThreadList(listRead.body), [listRead.body]);
  const threadRead = useDeliveryRead(active, selected ? `/api/threads/${selected}` : null, {
    pollMs: 4_000,
  });
  const thread = useMemo(() => parseOrchestratorThread(threadRead.body), [threadRead.body]);
  const act = useAtomCommand(deliveryEnvironment.act, {
    label: "orchestrator",
    reportFailure: false,
  });
  const stale = useStaleReading(threadRead.readAt);

  const isDraft = thread?.state === "draft";
  const isNew = selected === null;
  const editing = isNew || isDraft;

  // A saved draft is loaded into the form once, when it is opened.
  const [loaded, setLoaded] = useState<string | null>(null);
  if (thread && thread.state === "draft" && loaded !== thread.thread) {
    setLoaded(thread.thread);
    setTeam(thread.team);
    setText(thread.draft?.text ?? "");
    setSeats(Object.fromEntries(thread.settings.map((item) => [item.seat, { ...item.set }])));
  }

  const chosenTeam = teams.find((item) => item.team === (editing ? team : thread?.team));
  const seatsToSend = chosenTeam ? seatSettingsToSend(chosenTeam.settings, seats) : {};
  const engineDown = teamsRead.error ?? threadRead.error ?? listRead.error;

  const run = async (path: string, body: unknown) => {
    if (!environmentId) return null;
    setBusy(true);
    setProblem(null);
    const result = await act({ environmentId, input: { path: path as never, body } });
    setBusy(false);
    listRead.refresh();
    threadRead.refresh();
    if (result._tag === "Failure") {
      setProblem(deliveryFailureText(squashAtomCommandFailure(result)));
      return null;
    }
    return parseOrchestratorThread(result.value.body);
  };

  const saveDraft = async () => {
    const body = { team, workflow: "standard", text: text.trim(), seats: seatsToSend };
    const saved =
      isDraft && selected
        ? await run(`/api/threads/${selected}/draft`, body)
        : await run("/api/threads", { ...body, start: false });
    if (saved && saved.thread !== selected) {
      setLoaded(saved.thread);
      select(saved.thread);
    }
    return saved;
  };

  const startWorkflow = async () => {
    const saved = await saveDraft();
    if (!saved) return;
    const started = await run(`/api/threads/${saved.thread}/start`, {});
    if (started) {
      setText("");
      setSeats({});
      setPanel("council");
    }
  };

  const send = async (kind: "question" | "change") => {
    if (!selected || !message.trim()) return;
    const sent = await run(`/api/threads/${selected}/messages`, { text: message.trim(), kind });
    if (sent) setMessage("");
  };

  const newDraft = () => {
    setLoaded(null);
    setTeam(DELIVERY_DEFAULT_TEAM);
    setText("");
    setSeats({});
    setProblem(null);
    select(null);
  };

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 py-2">
            <h1 className="text-sm font-medium">Orchestrator</h1>
            <Select
              value={selected ?? "__new__"}
              onValueChange={(value) => (value === "__new__" ? newDraft() : select(String(value)))}
            >
              <SelectTrigger
                aria-label="Workflow"
                size="compact"
                variant="ghost"
                className="w-auto max-w-72 min-w-0"
              >
                <SelectValue>{thread?.title ?? "New draft"}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="__new__">New draft</SelectItem>
                {threads.map((item) => (
                  <SelectItem key={item.thread} value={item.thread}>
                    <span className="flex flex-col">
                      <span>{item.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {item.team},{" "}
                        {item.state === "draft"
                          ? "draft, not started"
                          : (item.taskState ?? "started")}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Badge size="sm" variant={editing ? "warning" : "outline"} data-delivery-thread-state>
              {editing ? "Draft, nothing is running" : `Team ${thread?.team ?? ""}`}
            </Badge>
            {thread?.task ? (
              <span className="font-mono text-[10px] text-muted-foreground">
                {thread.task.id} r{thread.task.revision}: {thread.task.state}
                {thread.working ? ", working" : ""}
                {threadRead.readAt ? `, read ${threadRead.readAt}${stale ? " (stale)" : ""}` : ""}
              </span>
            ) : null}
            <Link to="/board" className="ml-auto text-xs text-muted-foreground underline">
              Board
            </Link>
          </div>
        </WorkspacePageHeader>

        {!enabled ? (
          <p className="p-6 text-sm text-muted-foreground">
            Delivery is turned off for this environment. Turn it on in the server settings to talk
            to a team.
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {engineDown ? (
                <p className="px-5 pt-3 text-sm text-warning">
                  Delivery engine not reachable. {engineDown} This is not an ordinary chat and it
                  will not answer as one.
                </p>
              ) : null}
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-3 p-5">
                  {editing ? (
                    <>
                      <p className="text-sm text-muted-foreground">
                        Write what you want done, choose the team, and set the seats if you want
                        them to differ from what the team defines. Nothing runs until you start the
                        workflow. Started, it is triaged, planned, built, reviewed and tested, and
                        then waits for your decision. Nothing is merged.
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">Team</span>
                        <Select
                          value={team}
                          onValueChange={(value) => {
                            setTeam(String(value));
                            // Settings made for one team's seats mean nothing for another's.
                            setSeats({});
                          }}
                        >
                          <SelectTrigger
                            aria-label="Team"
                            size="compact"
                            className="w-auto min-w-40"
                          >
                            <SelectValue>{team}</SelectValue>
                          </SelectTrigger>
                          <SelectPopup alignItemWithTrigger={false}>
                            {teams.map((item) => (
                              <SelectItem
                                key={item.team}
                                value={item.team}
                                disabled={!item.available}
                              >
                                <span className="flex flex-col">
                                  <span>{item.team}</span>
                                  <span className="text-xs text-muted-foreground">
                                    {item.available ? item.purpose : (item.why ?? "Not available")}
                                  </span>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                        <span className="text-xs text-muted-foreground">Workflow</span>
                        <span className="text-xs">
                          {chosenTeam?.workflows[0]?.title ?? "Standard flow"}:{" "}
                          {chosenTeam?.workflows[0]?.stages.join(", ") ?? ""}
                        </span>
                      </div>
                      <Textarea
                        aria-label="What is asked"
                        placeholder={`What team ${team} is asked to do`}
                        className="min-h-40"
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                      />
                    </>
                  ) : (
                    thread?.messages.map((item) => (
                      <div
                        key={item.seq}
                        data-message-kind={item.kind ?? "note"}
                        className={
                          item.from === "person"
                            ? "ml-auto max-w-[85%] rounded-lg bg-accent px-3 py-2 text-sm whitespace-pre-wrap"
                            : "max-w-[85%] rounded-lg border border-border px-3 py-2 text-sm whitespace-pre-wrap"
                        }
                      >
                        <p className="pb-0.5 font-mono text-[10px] text-muted-foreground">
                          {item.from === "person" ? "You" : "Coordinator"}
                          {item.kind ? `, ${KIND_LABEL[item.kind] ?? item.kind}` : ""}, {item.at}
                        </p>
                        {item.text}
                      </div>
                    ))
                  )}
                  {thread && thread.pendingFromPerson > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {thread.pendingFromPerson} change{thread.pendingFromPerson === 1 ? "" : "s"}{" "}
                      of yours wait for the running step to end.
                    </p>
                  ) : null}
                </div>
              </ScrollArea>

              <div className="flex flex-col gap-2 border-t border-border p-3">
                {problem ? (
                  <p className="text-sm text-warning" data-delivery-problem>
                    {problem}
                  </p>
                ) : null}
                {editing ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {Object.keys(seatsToSend).length > 0
                        ? `${Object.keys(seatsToSend).length} seat(s) set for this run.`
                        : "Every seat runs as the team defines it."}
                      {chosenTeam && !chosenTeam.available
                        ? ` ${chosenTeam.why ?? "This team cannot work now."}`
                        : ""}
                    </span>
                    <span className="flex gap-2">
                      {isDraft && selected ? (
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void run(`/api/threads/${selected}/discard`, {}).then(newDraft)
                          }
                        >
                          Discard draft
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        disabled={busy || !text.trim() || Boolean(engineDown)}
                        onClick={() => void saveDraft()}
                      >
                        Save draft
                      </Button>
                      <Button
                        data-delivery-start-workflow
                        disabled={
                          busy ||
                          !text.trim() ||
                          Boolean(engineDown) ||
                          chosenTeam?.available === false
                        }
                        onClick={() => void startWorkflow()}
                      >
                        Start workflow
                      </Button>
                    </span>
                  </div>
                ) : (
                  <>
                    <Textarea
                      aria-label="Message to the team"
                      placeholder="Ask how things stand, or say what is to change"
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                    />
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="max-w-xl text-xs text-muted-foreground">
                        A question is answered from the engine's record and changes nothing. A
                        change becomes a new revision of the task, ends earlier approvals, and sends
                        the task back to triage.
                      </span>
                      <span className="flex gap-2">
                        <Button
                          variant="outline"
                          disabled={busy || !message.trim() || Boolean(engineDown)}
                          onClick={() => void send("question")}
                        >
                          Ask about progress
                        </Button>
                        <Button
                          variant="destructive-outline"
                          disabled={busy || !message.trim() || Boolean(engineDown)}
                          onClick={() => void send("change")}
                        >
                          Change what is asked
                        </Button>
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>

            <aside className="flex min-h-0 w-full shrink-0 flex-col border-t border-border lg:w-[30rem] lg:border-t-0 lg:border-l">
              <div className="flex gap-1 border-b border-border p-2">
                {(["council", "seats", "setup"] as const).map((item) => (
                  <Button
                    key={item}
                    size="xs"
                    variant={panel === item ? "secondary" : "ghost"}
                    onClick={() => setPanel(item)}
                  >
                    {item === "council" ? "Team" : item === "seats" ? "Seats" : "Setup"}
                  </Button>
                ))}
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-4 p-4">
                  {panel === "seats" ? (
                    <section>
                      <h2 className="pb-1 text-xs font-medium text-muted-foreground">
                        {editing
                          ? "Model, reasoning and access for each seat of this run"
                          : "What each seat of this run was started with"}
                      </h2>
                      <SeatSettingsPanel
                        settings={editing ? (chosenTeam?.settings ?? []) : (thread?.settings ?? [])}
                        roster={editing ? (chosenTeam?.seats ?? []) : (thread?.roster ?? [])}
                        chosen={seats}
                        onChange={
                          editing
                            ? (seat, choice) =>
                                setSeats((current) => {
                                  const merged = Object.fromEntries(
                                    Object.entries({ ...current[seat], ...choice }).filter(
                                      ([, value]) => typeof value === "string" && value !== "",
                                    ),
                                  );
                                  const { [seat]: _previous, ...others } = current;
                                  return Object.keys(merged).length > 0
                                    ? { ...others, [seat]: merged }
                                    : others;
                                })
                            : undefined
                        }
                      />
                    </section>
                  ) : null}
                  {panel === "setup" && chosenTeam ? (
                    <TeamProfilePanel
                      environmentId={active}
                      team={chosenTeam.team}
                      harness={null}
                      role={null}
                    />
                  ) : null}
                  {panel === "council" ? (
                    <>
                      <section>
                        <h2 className="pb-1 text-xs font-medium text-muted-foreground">
                          Team {chosenTeam?.team ?? team}
                          {thread?.configuration
                            ? `, setup ${thread.configuration}`
                            : chosenTeam
                              ? `, setup ${chosenTeam.configuration}`
                              : ""}
                        </h2>
                        <Roster
                          roster={editing ? (chosenTeam?.seats ?? []) : (thread?.roster ?? [])}
                          seats={thread?.council?.seats ?? []}
                        />
                      </section>
                      {thread?.council ? (
                        <>
                          <section className="text-xs">
                            <h2 className="pb-1 font-medium text-muted-foreground">Current run</h2>
                            <p className="font-mono text-[10px]">
                              {thread.council.run}: {thread.council.state} at {thread.council.stage}
                            </p>
                            <p className="text-muted-foreground">
                              {thread.council.concurrency.active} of{" "}
                              {thread.council.concurrency.global} slots in use,{" "}
                              {thread.council.concurrency.waiting} waiting.
                            </p>
                            {thread.council.candidate ? (
                              <p className="font-mono text-[10px] text-muted-foreground">
                                candidate {thread.council.candidate.slice(0, 10)}
                              </p>
                            ) : null}
                            {thread.council.decision ? (
                              <p className="pt-1">
                                Waiting for your decision. Decide on the{" "}
                                <Link to="/board" className="underline">
                                  board
                                </Link>
                                .
                              </p>
                            ) : null}
                            {thread.council.evidence ? (
                              <p className="font-mono text-[10px] break-all text-muted-foreground">
                                evidence: {thread.council.evidence}
                              </p>
                            ) : null}
                          </section>
                          {thread.council.votes.length > 0 ? (
                            <section className="text-xs">
                              <h2 className="pb-1 font-medium text-muted-foreground">
                                QA, by provider
                              </h2>
                              {thread.council.votes.map((vote) => (
                                <p key={vote.seat}>
                                  <Badge
                                    size="sm"
                                    variant={vote.verdict === "pass" ? "success" : "error"}
                                  >
                                    {vote.verdict}
                                  </Badge>{" "}
                                  {vote.provider} ({vote.seat}): {vote.reason}
                                </p>
                              ))}
                            </section>
                          ) : null}
                          {thread.council.findings.length > 0 ? (
                            <section className="text-xs">
                              <h2 className="pb-1 font-medium text-muted-foreground">Findings</h2>
                              {thread.council.findings.map((finding) => (
                                <p key={finding.id}>
                                  {finding.blocking ? "Blocking. " : ""}
                                  {finding.title} ({finding.seat}, {finding.status})
                                </p>
                              ))}
                            </section>
                          ) : null}
                        </>
                      ) : null}
                      {thread && thread.children.length > 0 ? (
                        <section className="text-xs">
                          <h2 className="pb-1 font-medium text-muted-foreground">
                            Runs of this workflow
                          </h2>
                          {thread.children.map((child) => (
                            <p key={child.run} className="font-mono text-[10px]">
                              {child.run}: {child.state} at {child.stage}
                              {child.whole ? " (the whole task)" : ""}
                            </p>
                          ))}
                        </section>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </ScrollArea>
            </aside>
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
