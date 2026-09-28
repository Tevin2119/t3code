import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { DELIVERY_DEFAULT_TEAM } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import {
  deliveryFailureText,
  parseOrchestratorThread,
  parseTeams,
  parseThreadList,
  type CouncilSeat,
  type DeliverySeat,
} from "../../lib/delivery";
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
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const ACTIVITY_VARIANT: Record<string, "success" | "info" | "warning" | "secondary" | "error"> = {
  active: "info",
  queued: "warning",
  completed: "success",
  waiting: "secondary",
  unavailable: "error",
};

function Roster(props: {
  readonly roster: ReadonlyArray<DeliverySeat>;
  readonly seats: ReadonlyArray<CouncilSeat>;
}) {
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-muted-foreground">
        <tr>
          <th className="py-1 pr-2 font-normal">Seat</th>
          <th className="py-1 pr-2 font-normal">Harness</th>
          <th className="py-1 pr-2 font-normal">Model</th>
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
              <td className="py-1 pr-2 font-mono text-[10px]">
                {seat.model ?? "the harness's own"}
              </td>
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
 * A conversation with a team. The message becomes a task of the team and
 * goes through its flow. The replies are the engine's own record of what
 * happened; no model speaks for the team here.
 */
export function OrchestratorPage() {
  const environmentId = usePrimaryEnvironmentId();
  const enabled = useDeliveryEnabled(environmentId);
  const active = enabled ? environmentId : null;
  const [selected, setSelected] = useState<string | null>(null);
  const [team, setTeam] = useState<string>(DELIVERY_DEFAULT_TEAM);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

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
    label: "orchestrator message",
    reportFailure: false,
  });

  const chosenTeam = teams.find((item) => item.team === (thread?.team ?? team));
  const stale = useStaleReading(threadRead.readAt);

  const send = async () => {
    if (!environmentId || !message.trim()) return;
    setBusy(true);
    setProblem(null);
    const result = await act({
      environmentId,
      input: selected
        ? { path: `/api/threads/${selected}/messages` as never, body: { text: message.trim() } }
        : { path: "/api/threads" as never, body: { team, text: message.trim() } },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setProblem(deliveryFailureText(squashAtomCommandFailure(result)));
      return;
    }
    const started = parseOrchestratorThread(result.value.body);
    if (started) setSelected(started.thread);
    setMessage("");
    listRead.refresh();
    threadRead.refresh();
  };

  const engineDown = teamsRead.error ?? threadRead.error ?? listRead.error;

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 py-2">
            <h1 className="text-sm font-medium">Orchestrator</h1>
            <Select
              value={selected ?? "__new__"}
              onValueChange={(value) => setSelected(value === "__new__" ? null : String(value))}
            >
              <SelectTrigger
                aria-label="Conversation"
                size="compact"
                variant="ghost"
                className="w-auto min-w-0 max-w-72"
              >
                <SelectValue>{thread?.title ?? "New conversation"}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="__new__">New conversation</SelectItem>
                {threads.map((item) => (
                  <SelectItem key={item.thread} value={item.thread}>
                    <span className="flex flex-col">
                      <span>{item.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {item.team}, {item.state ?? "unknown"}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {selected ? (
              <Badge size="sm" variant="outline">
                {thread?.team ?? ""}
              </Badge>
            ) : (
              <Select value={team} onValueChange={(value) => setTeam(String(value))}>
                <SelectTrigger
                  aria-label="Team"
                  size="compact"
                  variant="ghost"
                  className="w-auto min-w-0"
                >
                  <SelectValue>{team}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {teams.map((item) => (
                    <SelectItem key={item.team} value={item.team} disabled={!item.available}>
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
            )}
            {thread ? (
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
                  {thread ? (
                    thread.messages.map((item) => (
                      <div
                        key={item.seq}
                        className={
                          item.from === "person"
                            ? "ml-auto max-w-[85%] rounded-lg bg-accent px-3 py-2 text-sm whitespace-pre-wrap"
                            : "max-w-[85%] rounded-lg border border-border px-3 py-2 text-sm whitespace-pre-wrap"
                        }
                      >
                        <p className="pb-0.5 font-mono text-[10px] text-muted-foreground">
                          {item.from === "person" ? "You" : "Coordinator, from the engine's record"}
                          , {item.at}
                        </p>
                        {item.text}
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Write what you want done. It is filed as a task for the team, triaged,
                      planned, built, reviewed and tested, and then waits for your decision. Nothing
                      is merged.
                    </p>
                  )}
                  {thread && thread.pendingFromPerson > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {thread.pendingFromPerson} message
                      {thread.pendingFromPerson === 1 ? "" : "s"} of yours wait for the running step
                      to end.
                    </p>
                  ) : null}
                </div>
              </ScrollArea>
              <div className="flex flex-col gap-2 border-t border-border p-3">
                {problem ? <p className="text-sm text-warning">{problem}</p> : null}
                <Textarea
                  aria-label="Message to the team"
                  placeholder={
                    selected
                      ? "Add to what is asked. The task goes back to triage."
                      : `Message to team ${team}`
                  }
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {selected
                      ? "A later message changes what is asked and ends earlier approvals."
                      : chosenTeam && !chosenTeam.available
                        ? (chosenTeam.why ?? "This team cannot work now.")
                        : ""}
                  </span>
                  <Button
                    disabled={
                      busy ||
                      !message.trim() ||
                      Boolean(engineDown) ||
                      (!selected && chosenTeam?.available === false)
                    }
                    onClick={() => void send()}
                  >
                    {selected ? "Send" : "Start"}
                  </Button>
                </div>
              </div>
            </div>

            <aside className="flex min-h-0 w-full shrink-0 flex-col border-t border-border lg:w-96 lg:border-t-0 lg:border-l">
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-4 p-4">
                  <section>
                    <h2 className="pb-1 text-xs font-medium text-muted-foreground">
                      Team {chosenTeam?.team ?? team}
                      {chosenTeam ? `, setup ${chosenTeam.configuration}` : ""}
                    </h2>
                    <Roster
                      roster={thread?.roster ?? chosenTeam?.seats ?? []}
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
                          {thread.council.concurrency.active} of {thread.council.concurrency.global}{" "}
                          slots in use, {thread.council.concurrency.waiting} waiting.
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
                        Runs of this thread
                      </h2>
                      {thread.children.map((child) => (
                        <p key={child.run} className="font-mono text-[10px]">
                          {child.run}: {child.state} at {child.stage}
                          {child.whole ? " (the whole task)" : ""}
                        </p>
                      ))}
                    </section>
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
