import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CopyIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  flowFor,
  parseSeatSetup,
  parseTeams,
  seatSettingsToSend,
  teamTaskBlock,
  type DeliveryFlow,
  type SeatSetup,
} from "../../lib/delivery";
import { cn } from "../../lib/utils";
import {
  useDeliveryAct,
  useDeliveryRead,
  useOrchestratorDraft,
  useOrchestratorDraftStore,
} from "../../state/delivery";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SeatSettingsPanel } from "./SeatSettingsPanel";
import { SetupPanel } from "./SetupPanel";
import { TeamDefaultsDialog } from "./TeamDefaultsDialog";

/** What a flow would do with the seats as they are set, read from the engine. */
export function useFlowPreview(
  environmentId: EnvironmentId | null,
  team: string | null,
  flow: string | null,
  seats: Readonly<Record<string, Record<string, string>>>,
): SeatSetup | null {
  const act = useDeliveryAct(environmentId, "flow preview");
  const [preview, setPreview] = useState<SeatSetup | null>(null);
  const asked = useRef(0);
  const sent = JSON.stringify(seats);
  useEffect(() => {
    if (!team) return;
    asked.current += 1;
    const mine = asked.current;
    // A short wait, so that a row of switches is asked about once.
    const timer = window.setTimeout(() => {
      void act(`/api/teams/${team}/setup`, { flow, seats: JSON.parse(sent) }).then((result) => {
        if (mine !== asked.current || !result.ok) return;
        setPreview(parseSeatSetup(result.body));
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [act, flow, sent, team]);
  return preview?.team === team ? preview : null;
}

export function FlowChoice(props: {
  readonly flows: ReadonlyArray<DeliveryFlow>;
  readonly value: string;
  readonly onChange: (flow: string) => void;
}) {
  return (
    <div
      className="grid gap-1.5 sm:grid-cols-2"
      role="radiogroup"
      aria-label="Flow"
      data-flow-choice
    >
      {props.flows.map((flow) => {
        const chosen = flow.id === props.value;
        const card = (
          <button
            key={flow.id}
            type="button"
            role="radio"
            aria-checked={chosen}
            disabled={!flow.offered}
            data-flow={flow.id}
            data-flow-chosen={chosen ? "true" : "false"}
            onClick={() => props.onChange(flow.id)}
            className={cn(
              "flex cursor-pointer flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left text-xs transition-colors",
              chosen ? "border-primary bg-primary/5" : "border-border hover:bg-accent",
              !flow.offered && "cursor-not-allowed opacity-50 hover:bg-transparent",
            )}
          >
            <span className="flex items-center gap-1.5 font-medium">
              {flow.title}
              {flow.offered && !flow.ready && chosen ? (
                <Badge size="sm" variant="warning">
                  lacks seats
                </Badge>
              ) : null}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {flow.stages.join(", ")}. Stops at: {flow.stop}.
            </span>
          </button>
        );
        return (
          <Tooltip key={flow.id}>
            <TooltipTrigger render={<span className="contents" />}>{card}</TooltipTrigger>
            <TooltipPopup side="top" className="max-w-80">
              {flow.offered ? flow.summary : `${flow.why}.`}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * The team a thread is given to, set up where the models of a single harness
 * are chosen: which profile, which flow, which seats take part and what each
 * runs on. What is set here is the draft of a workflow. Nothing runs for it
 * until it is started.
 */
export function OrchestratorPanel(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: string;
  readonly onRequestClose: () => void;
}) {
  const navigate = useNavigate();
  const draft = useOrchestratorDraft(props.threadId);
  const update = useOrchestratorDraftStore((state) => state.update);
  const setSeat = useOrchestratorDraftStore((state) => state.setSeat);
  const teamsRead = useDeliveryRead(props.environmentId, "/api/teams");
  const teams = useMemo(
    () => parseTeams(teamsRead.body).filter((team) => team.team !== "triage"),
    [teamsRead.body],
  );
  const [showing, setShowing] = useState<"seats" | "setup">("seats");
  const [editingDefaults, setEditingDefaults] = useState(false);

  const team = teams.find((candidate) => candidate.team === draft?.team) ?? null;
  const flow = flowFor(team, draft?.workflow ?? null);
  const seatsToSend = useMemo(
    () => (team && draft ? seatSettingsToSend(team.settings, draft.seats) : {}),
    [draft, team],
  );
  const preview = useFlowPreview(props.environmentId, team?.team ?? null, flow, seatsToSend);
  const flows = preview?.flows ?? team?.flows ?? [];
  const chosen = flows.find((item) => item.id === flow) ?? null;
  // A flow the team has and the draft does not name yet is written into the draft.
  useEffect(() => {
    if (draft && team && draft.workflow !== flow) update(props.threadId, { workflow: flow });
  }, [draft, flow, props.threadId, team, update]);

  if (!draft) return null;
  const open = (search: { name?: string; new?: boolean; from?: string }) => {
    props.onRequestClose();
    void navigate({ to: "/profiles", search });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm" data-delivery-orchestrator-panel>
      <header className="flex flex-col gap-1.5 border-b border-border/70 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-medium">Orchestrator</h3>
          <span className="truncate text-[11px] text-muted-foreground">
            A team in place of one model. Nothing runs until you start it.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Select
            value={draft.team}
            onValueChange={(value) => update(props.threadId, { team: String(value) })}
          >
            <SelectTrigger aria-label="Profile" size="compact" className="w-auto min-w-44">
              <SelectValue>{draft.team}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {teams.map((item) => (
                <SelectItem
                  key={item.team}
                  value={item.team}
                  disabled={teamTaskBlock(item) !== null}
                >
                  <span className="flex max-w-96 flex-col">
                    <span>
                      {item.team}
                      {item.source === "custom" ? " (your profile)" : ""}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {teamTaskBlock(item) ?? item.purpose}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={team?.source === "custom" ? "Edit this profile" : "See this profile"}
                  onClick={() => open({ name: draft.team })}
                  data-profile-open
                />
              }
            >
              <PencilIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {team?.source === "custom"
                ? "Edit this profile: its core prompt, seats, tools and default flow."
                : "See this profile. It comes with the engine: duplicate it to change it."}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Duplicate this profile"
                  onClick={() => open({ new: true, from: draft.team })}
                />
              }
            >
              <CopyIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Duplicate this profile into one of your own.</TooltipPopup>
          </Tooltip>
          <Button size="xs" variant="ghost" onClick={() => open({ new: true })} data-profile-new>
            <PlusIcon />
            New profile
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-2">
        {teamsRead.error ? (
          <p className="text-xs text-warning">Delivery engine not reachable. {teamsRead.error}</p>
        ) : null}
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">Flow</h4>
          <FlowChoice
            flows={flows}
            value={flow}
            onChange={(next) => update(props.threadId, { workflow: next })}
          />
          {chosen && chosen.problems.length > 0 ? (
            <ul className="list-disc pl-5 text-[11px] text-warning" data-flow-problems>
              {chosen.problems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant={showing === "seats" ? "secondary" : "ghost"}
              onClick={() => setShowing("seats")}
            >
              Seats
            </Button>
            <Button
              size="xs"
              variant={showing === "setup" ? "secondary" : "ghost"}
              onClick={() => setShowing("setup")}
              data-orchestrator-setup
            >
              Setup
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto"
              onClick={() => setEditingDefaults(true)}
            >
              Team defaults
            </Button>
          </div>
          {showing === "seats" && team ? (
            <SeatSettingsPanel
              environmentId={props.environmentId}
              settings={team.settings}
              chosen={draft.seats}
              taking={chosen?.seats}
              onChange={(seat, choice) => setSeat(props.threadId, seat, choice)}
            />
          ) : null}
          {showing === "setup" && team ? (
            <SetupPanel
              environmentId={props.environmentId}
              team={team.team}
              flow={flow}
              seats={seatsToSend}
            />
          ) : null}
        </section>
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border/70 px-3 py-1.5">
        <span
          className="min-w-0 truncate text-[11px] text-muted-foreground"
          data-orchestrator-summary
        >
          {chosen
            ? `${chosen.title} with ${chosen.seats.length} seat${chosen.seats.length === 1 ? "" : "s"}: ${chosen.seats.join(", ")}`
            : "Choose a profile and a flow."}
        </span>
        <Button size="xs" onClick={props.onRequestClose} data-orchestrator-done>
          Done
        </Button>
      </footer>

      {editingDefaults ? (
        <TeamDefaultsDialog
          environmentId={props.environmentId}
          team={draft.team}
          onClose={() => setEditingDefaults(false)}
          onSaved={teamsRead.refresh}
        />
      ) : null}
    </div>
  );
}
