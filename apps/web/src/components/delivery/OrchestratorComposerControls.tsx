import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlayIcon, SaveIcon, SlidersHorizontalIcon, UsersIcon, WorkflowIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  deliveryFailureText,
  parseOrchestratorThread,
  parseTeams,
  seatSettingsToSend,
} from "../../lib/delivery";
import {
  deliveryEnvironment,
  useDeliveryRead,
  useOrchestratorDraft,
  useOrchestratorDraftStore,
} from "../../state/delivery";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SeatSettingsPanel } from "./SeatSettingsPanel";
import { TeamProfilePanel } from "./TeamProfilePanel";

/**
 * The composer's controls while it prepares a workflow for a team. They take
 * the place of the model, reasoning and access controls of a single harness:
 * a team has a model for each seat, set in the seats panel.
 *
 * What is typed is a draft. Saving keeps it on the engine, where nothing
 * runs. Only "Start workflow" starts the team.
 */
export function OrchestratorComposerControls(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: string;
  readonly prompt: string;
  readonly onPromptCleared: () => void;
}) {
  const navigate = useNavigate();
  const draft = useOrchestratorDraft(props.threadId);
  const update = useOrchestratorDraftStore((state) => state.update);
  const setSeat = useOrchestratorDraftStore((state) => state.setSeat);
  const leave = useOrchestratorDraftStore((state) => state.leave);
  const saveRequest = useOrchestratorDraftStore((state) => state.saveRequests[props.threadId] ?? 0);
  const teamsRead = useDeliveryRead(props.environmentId, "/api/teams");
  const teams = useMemo(
    () => parseTeams(teamsRead.body).filter((team) => team.team !== "triage"),
    [teamsRead.body],
  );
  const act = useAtomCommand(deliveryEnvironment.act, {
    label: "orchestrator draft",
    reportFailure: false,
  });
  const [busy, setBusy] = useState<"save" | "start" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const team = teams.find((candidate) => candidate.team === draft?.team) ?? null;
  const workflow =
    team?.workflows.find((item) => item.id === draft?.workflow) ?? team?.workflows[0];
  const text = props.prompt.trim();
  const seatsToSend = useMemo(
    () => (team && draft ? seatSettingsToSend(team.settings, draft.seats) : {}),
    [draft, team],
  );
  const changedSeats = Object.keys(seatsToSend).length;
  const unsaved = draft !== null && text.length > 0 && text !== (draft.savedText ?? "");

  const save = useCallback(async (): Promise<string | null> => {
    if (!props.environmentId || !draft) return null;
    setProblem(null);
    setNote(null);
    const body = { team: draft.team, workflow: draft.workflow, text, seats: seatsToSend };
    const result = await act({
      environmentId: props.environmentId,
      input: draft.engineThread
        ? { path: `/api/threads/${draft.engineThread}/draft` as never, body }
        : { path: "/api/threads" as never, body: { ...body, start: false } },
    });
    if (result._tag === "Failure") {
      setProblem(deliveryFailureText(squashAtomCommandFailure(result)));
      return null;
    }
    const saved = parseOrchestratorThread(result.value.body);
    if (!saved) {
      setProblem("The delivery engine answered with something that is not a workflow.");
      return null;
    }
    update(props.threadId, { engineThread: saved.thread, savedText: text });
    return saved.thread;
  }, [act, draft, props.environmentId, props.threadId, seatsToSend, text, update]);

  const onSave = useCallback(async () => {
    setBusy("save");
    const saved = await save();
    setBusy(null);
    if (saved) setNote("Draft saved. Nothing has started.");
  }, [save]);

  // The send key saves the draft. It never starts the team.
  const handled = useRef(saveRequest);
  useEffect(() => {
    if (saveRequest === handled.current) return;
    handled.current = saveRequest;
    void onSave();
  }, [onSave, saveRequest]);

  const onStart = async () => {
    if (!props.environmentId) return;
    setBusy("start");
    const saved = await save();
    if (!saved) {
      setBusy(null);
      return;
    }
    const result = await act({
      environmentId: props.environmentId,
      input: { path: `/api/threads/${saved}/start` as never, body: {} },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      setProblem(deliveryFailureText(squashAtomCommandFailure(result)));
      return;
    }
    props.onPromptCleared();
    leave(props.threadId);
    void navigate({ to: "/orchestrator", search: { thread: saved } });
  };

  if (!draft) return null;

  return (
    <div
      className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5"
      data-delivery-orchestrator
    >
      <Select
        value={draft.team}
        onValueChange={(value) => update(props.threadId, { team: String(value) })}
      >
        <SelectTrigger aria-label="Team" size="compact" variant="ghost" className="w-auto min-w-0">
          <UsersIcon className="size-3.5" />
          <SelectValue>{draft.team}</SelectValue>
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

      <Select
        value={workflow?.id ?? "standard"}
        onValueChange={(value) => update(props.threadId, { workflow: String(value) })}
      >
        <SelectTrigger
          aria-label="Workflow"
          size="compact"
          variant="ghost"
          className="w-auto min-w-0"
        >
          <WorkflowIcon className="size-3.5" />
          <SelectValue>{workflow?.title ?? "Standard flow"}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {(team?.workflows ?? []).map((item) => (
            <SelectItem key={item.id} value={item.id}>
              <span className="flex max-w-80 flex-col">
                <span>{item.title}</span>
                <span className="text-xs text-muted-foreground">
                  {item.stages.join(", ")}, then {item.stop}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>

      <Popover>
        <PopoverTrigger
          render={
            <Button size="xs" variant="ghost" aria-label="Seats" data-delivery-seats-button />
          }
        >
          <SlidersHorizontalIcon />
          Seats{changedSeats > 0 ? ` (${changedSeats} set)` : ""}
        </PopoverTrigger>
        <PopoverPopup side="top" align="start" className="w-[44rem] max-w-[calc(100vw-2rem)]">
          <PopoverTitle className="pb-1 text-sm">Seats of team {draft.team}</PopoverTitle>
          <p className="pb-2 text-xs text-muted-foreground">
            A team has a model for each seat. What you leave alone runs as the team defines it. What
            you set is recorded with the run.
          </p>
          {team ? (
            <div className="max-h-[50vh] overflow-y-auto">
              <SeatSettingsPanel
                settings={team.settings}
                roster={team.seats}
                chosen={draft.seats}
                onChange={(seat, choice) => setSeat(props.threadId, seat, choice)}
              />
            </div>
          ) : (
            <p className="text-xs text-warning">
              {teamsRead.error
                ? `Delivery engine not reachable. ${teamsRead.error}`
                : "Reading the team."}
            </p>
          )}
        </PopoverPopup>
      </Popover>

      {team ? (
        <Popover>
          <PopoverTrigger
            render={<Button size="xs" variant="ghost" aria-label="Inspect team setup" />}
          >
            Setup
          </PopoverTrigger>
          <PopoverPopup side="top" align="start" className="w-[34rem] max-w-[calc(100vw-2rem)]">
            <PopoverTitle className="pb-2 text-sm">Team setup</PopoverTitle>
            <TeamProfilePanel
              environmentId={props.environmentId}
              team={team.team}
              harness={null}
              role={null}
            />
          </PopoverPopup>
        </Popover>
      ) : null}

      <span className="ml-auto flex items-center gap-1">
        <span
          className={
            problem
              ? "max-w-72 truncate text-xs text-warning"
              : "max-w-72 truncate text-xs text-muted-foreground"
          }
          title={problem ?? note ?? ""}
          data-delivery-orchestrator-status
        >
          {problem ??
            note ??
            (draft.engineThread
              ? unsaved
                ? "Draft changed since it was saved"
                : "Draft saved"
              : "Not saved yet")}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={busy !== null || text.length === 0 || !props.environmentId}
          onClick={() => void onSave()}
        >
          <SaveIcon />
          {busy === "save" ? "Saving" : "Save draft"}
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                disabled={
                  busy !== null || text.length === 0 || !props.environmentId || !team?.available
                }
                onClick={() => void onStart()}
                data-delivery-start-workflow
              />
            }
          >
            <PlayIcon />
            {busy === "start" ? "Starting" : "Start workflow"}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {team && !team.available
              ? (team.why ?? "This team cannot work now.")
              : `Files this as a task for team ${draft.team} and starts the team. It stops for your decision before anything is merged.`}
          </TooltipPopup>
        </Tooltip>
      </span>
    </div>
  );
}
