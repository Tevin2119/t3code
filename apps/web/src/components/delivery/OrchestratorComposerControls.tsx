import type { EnvironmentId } from "@t3tools/contracts";
import { InfoPopover } from "./InfoPopover";
import { useNavigate } from "@tanstack/react-router";

import { whatStartDoes } from "../../lib/deliveryBoard";
import { PlayIcon, SaveIcon, SlidersHorizontalIcon, UsersIcon, WorkflowIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEventHandler } from "react";

import {
  flowFor,
  flowStartLabel,
  parseTask,
  parseTeams,
  seatIsOn,
  seatSettingsToSend,
  teamTaskBlock,
} from "../../lib/delivery";
import { cn } from "../../lib/utils";
import {
  useDeliveryAct,
  useDeliveryRead,
  useOrchestratorActivity,
  useOrchestratorDraft,
  useOrchestratorDraftStore,
  usePersonName,
} from "../../state/delivery";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useFlowPreview } from "./OrchestratorPanel";
import { SeatSettingsPanel } from "./SeatSettingsPanel";
import { SetupPanel } from "./SetupPanel";
import { TeamDefaultsDialog } from "./TeamDefaultsDialog";

/**
 * The composer's controls while it prepares work for a team. They take the
 * place of the model, reasoning and access controls of a single harness: a
 * team has a flow, and a harness and a model for each seat that takes part.
 *
 * What is typed is a draft. Saving keeps it on the engine, where nothing
 * runs. Starting saves it and gives it to the team in one step; the buttons
 * for both stand where Send stands, in `OrchestratorPrimaryActions`.
 */
export function OrchestratorComposerControls(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: string;
  readonly prompt: string;
  readonly onPromptCleared: () => void;
}) {
  const navigate = useNavigate();
  const person = usePersonName();
  const draft = useOrchestratorDraft(props.threadId);
  const update = useOrchestratorDraftStore((state) => state.update);
  const setSeat = useOrchestratorDraftStore((state) => state.setSeat);
  const leave = useOrchestratorDraftStore((state) => state.leave);
  const setActivity = useOrchestratorDraftStore((state) => state.setActivity);
  const saveRequest = useOrchestratorDraftStore((state) => state.saveRequests[props.threadId] ?? 0);
  const startRequest = useOrchestratorDraftStore(
    (state) => state.startRequests[props.threadId] ?? 0,
  );
  const teamsRead = useDeliveryRead(props.environmentId, "/api/teams");
  const teams = useMemo(
    () => parseTeams(teamsRead.body).filter((team) => team.team !== "triage"),
    [teamsRead.body],
  );
  const act = useDeliveryAct(props.environmentId, "orchestrator draft");
  const [busy, setBusy] = useState<"save" | "start" | null>(null);
  // Held from the press to the answer, so a second press cannot start a second workflow.
  const working = useRef(false);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);
  const [editingDefaults, setEditingDefaults] = useState(false);

  const team = teams.find((candidate) => candidate.team === draft?.team) ?? null;
  const flow = flowFor(team, draft?.workflow ?? null);
  const text = props.prompt.trim();
  const seatsToSend = useMemo(
    () => (team && draft ? seatSettingsToSend(team.settings, draft.seats) : {}),
    [draft, team],
  );
  const preview = useFlowPreview(props.environmentId, team?.team ?? null, flow, seatsToSend);
  const flows = preview?.flows ?? team?.flows ?? [];
  const chosen = flows.find((item) => item.id === flow) ?? null;
  const seatsOn = team
    ? team.settings.filter((item) => seatIsOn(item, draft?.seats[item.seat] ?? {})).length
    : 0;
  const seatsSet = Object.values(seatsToSend).filter((choice) =>
    Object.keys(choice).some((key) => key !== "active"),
  ).length;
  const saved =
    draft?.engineThread == null ? "new" : text !== (draft.savedText ?? "") ? "changed" : "saved";
  const blocked = !props.environmentId
    ? "No environment is connected."
    : teamsRead.error
      ? `Delivery engine not reachable. ${teamsRead.error}`
      : team && teamTaskBlock(team, flow)
        ? teamTaskBlock(team, flow)
        : chosen && chosen.problems.length > 0
          ? chosen.problems.join(" ")
          : text.length === 0
            ? "Write what the team is asked to do."
            : null;

  useEffect(() => {
    setActivity(props.threadId, { busy, blocked, team: draft?.team ?? null, saved, flow });
  }, [blocked, busy, draft?.team, flow, props.threadId, saved, setActivity]);

  const save = useCallback(async (): Promise<string | null> => {
    if (!draft) return null;
    setProblems([]);
    const body = { team: draft.team, workflow: flow, text, seats: seatsToSend, by: person };
    const result = draft.engineThread
      ? await act(`/api/tasks/${draft.engineThread}/edit`, body)
      : await act("/api/tasks", { ...body, draft: true });
    if (!result.ok) {
      setProblems(result.problems.length > 0 ? result.problems : [result.why]);
      return null;
    }
    const task = parseTask(result.body);
    if (!task) {
      setProblems(["The delivery engine answered with something that is not a task."]);
      return null;
    }
    update(props.threadId, { engineThread: task.id, savedText: text });
    return task.id;
  }, [act, draft, flow, person, props.threadId, seatsToSend, text, update]);

  const once = useCallback(async (kind: "save" | "start", work: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(kind);
    try {
      await work();
    } finally {
      working.current = false;
      setBusy(null);
    }
  }, []);

  const onSave = useCallback(() => {
    if (text.length === 0) return;
    void once("save", async () => {
      await save();
    });
  }, [once, save, text.length]);

  const { onPromptCleared, threadId } = props;
  const onStart = useCallback(() => {
    if (blocked) {
      setProblems([blocked]);
      return;
    }
    void once("start", async () => {
      const id = await save();
      if (!id) return;
      const result = await act(`/api/tasks/${id}/submit`, { by: person });
      if (!result.ok) {
        setProblems(result.problems.length > 0 ? result.problems : [result.why]);
        return;
      }
      onPromptCleared();
      leave(threadId);
      // What is written next is written on the task, in its own composer.
      void navigate({ to: "/orchestrator", search: { thread: id } });
    });
  }, [act, blocked, leave, navigate, once, onPromptCleared, person, save, threadId]);

  // The buttons stand in the composer's own place for Send, and ask from there.
  const handledSave = useRef(saveRequest);
  useEffect(() => {
    if (saveRequest === handledSave.current) return;
    handledSave.current = saveRequest;
    onSave();
  }, [onSave, saveRequest]);
  const handledStart = useRef(startRequest);
  useEffect(() => {
    if (startRequest === handledStart.current) return;
    handledStart.current = startRequest;
    onStart();
  }, [onStart, startRequest]);

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
            <SelectItem key={item.team} value={item.team} disabled={teamTaskBlock(item) !== null}>
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

      <Select
        value={flow}
        onValueChange={(value) => update(props.threadId, { workflow: String(value) })}
      >
        <SelectTrigger
          aria-label="Flow"
          size="compact"
          variant="ghost"
          className={cn("w-auto min-w-0", chosen && !chosen.ready && "text-warning")}
        >
          <WorkflowIcon className="size-3.5" />
          <SelectValue>{chosen?.title ?? flow}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {flows.map((item) => (
            <SelectItem key={item.id} value={item.id} disabled={!item.offered}>
              <span className="flex max-w-96 flex-col">
                <span>{item.title}</span>
                <span className="text-xs text-muted-foreground">
                  {item.offered ? item.summary : `${item.why}.`}
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
          Seats ({seatsOn} of {team?.settings.length ?? 0} on
          {seatsSet > 0 ? `, ${seatsSet} set` : ""})
        </PopoverTrigger>
        <PopoverPopup side="top" align="start" className="w-[34rem] max-w-[calc(100vw-2rem)]">
          <div className="flex items-center justify-between gap-2 pb-1">
            <PopoverTitle className="text-sm">Seats of team {draft.team}</PopoverTitle>
            <Button size="xs" variant="ghost" onClick={() => setEditingDefaults(true)}>
              Team defaults
            </Button>
          </div>
          <p className="pb-2 text-xs text-muted-foreground">
            Switch a seat off to leave it out. Each seat keeps its role. Choose the harness and the
            model it runs on for this work, or leave it on the team default. What you set is
            recorded with the run.
          </p>
          {chosen && chosen.problems.length > 0 ? (
            <ul className="list-disc pb-2 pl-5 text-[11px] text-warning" data-flow-problems>
              {chosen.problems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          {team ? (
            <div className="max-h-[50vh] overflow-y-auto">
              <SeatSettingsPanel
                environmentId={props.environmentId}
                settings={team.settings}
                chosen={draft.seats}
                taking={chosen?.seats}
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
            render={
              <Button
                size="xs"
                variant="ghost"
                aria-label="Inspect team setup"
                data-delivery-setup-button
              />
            }
          >
            Setup
          </PopoverTrigger>
          <PopoverPopup side="top" align="start" className="w-[38rem] max-w-[calc(100vw-2rem)]">
            <PopoverTitle className="pb-2 text-sm">What each seat is given</PopoverTitle>
            <SetupPanel
              environmentId={props.environmentId}
              team={team.team}
              flow={flow}
              seats={seatsToSend}
            />
          </PopoverPopup>
        </Popover>
      ) : null}

      {/* What Start does, a tap away: kept out of the way, and reachable on a phone. */}
      <InfoPopover label="What Start does" marker={{ "data-delivery-what-starts": flow }}>
        {whatStartDoes(flow, "Start")}
      </InfoPopover>

      {problems.length > 0 ? (
        <span
          className="ml-auto max-w-[32rem] text-xs text-warning"
          data-delivery-orchestrator-status
          role="alert"
        >
          {problems.join(" ")}
        </span>
      ) : null}

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

const SAVED_LABEL = {
  new: "Not saved yet",
  saved: "Draft saved",
  changed: "Changed since it was saved",
} as const;

const START_HELP: Readonly<Record<string, string>> = {
  chat: "which talks it over with you. The lead brings in the seats a message concerns. Nothing is built.",
  plan: "which triages it and plans it. It stops at the plan, and nothing is built until you start the delivery.",
  review: "which examines what is there and writes down what it finds. Nothing is changed.",
  standard:
    "which triages, plans, builds, reviews and tests it without being asked again. It stops for your decision before anything is merged.",
};

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

/**
 * What stands in the place of Send while the composer prepares work for a
 * team: the start where Send is, and Save draft beside it. The start button
 * submits the composer's form, so the send key does what the button does.
 */
export function OrchestratorPrimaryActions(props: {
  readonly threadId: string;
  readonly promptHasText: boolean;
  readonly preserveComposerFocusOnPointerDown?: boolean;
}) {
  const activity = useOrchestratorActivity(props.threadId);
  const requestSave = useOrchestratorDraftStore((state) => state.requestSave);
  const pointerFocusProps = props.preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const busy = activity.busy !== null;
  const start = flowStartLabel(activity.flow);
  const startLabel =
    activity.busy === "start"
      ? "Starting"
      : (activity.blocked ?? `${start} for team ${activity.team ?? ""}`.trim());

  return (
    <div className="flex items-center gap-1.5" data-delivery-primary-actions>
      {/* A new draft has nothing to say yet; once saved or changed, it says which, in words too. */}
      {activity.saved === "new" ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={0}
                role="status"
                aria-label={SAVED_LABEL[activity.saved]}
                data-delivery-draft-state={activity.saved}
                className="flex items-center gap-1 text-[10px] text-muted-foreground"
              />
            }
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                activity.saved === "saved"
                  ? "bg-emerald-500"
                  : activity.saved === "changed"
                    ? "bg-amber-500"
                    : "bg-muted-foreground/40",
              )}
            />
            {activity.saved === "saved" ? "saved" : "unsaved"}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {SAVED_LABEL[activity.saved]}. Nothing runs for a draft.
          </TooltipPopup>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="rounded-full"
              aria-label="Save draft"
              disabled={busy || !props.promptHasText}
              {...pointerFocusProps}
              onClick={() => requestSave(props.threadId)}
              data-delivery-save-draft
            />
          }
        >
          {activity.busy === "save" ? <Spinner className="size-3.5" /> : <SaveIcon />}
        </TooltipTrigger>
        <TooltipPopup side="top">
          Save draft. It is kept on the engine and nothing is started.
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="submit"
              className="relative flex h-9 w-9 items-center justify-center rounded-full bg-message-action text-message-action-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:shadow-message-action/24 enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:scale-105 hover:bg-message-action-hover disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none sm:h-8 sm:w-8"
              aria-label={startLabel}
              disabled={busy || activity.blocked !== null || !props.promptHasText}
              {...pointerFocusProps}
              data-delivery-start-workflow
              data-delivery-start-flow={activity.flow ?? ""}
            />
          }
        >
          {activity.busy === "start" ? (
            <Spinner className="size-3.5" aria-hidden="true" />
          ) : (
            <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-96">
          {activity.blocked ??
            `${start}. Saves this and gives it to team ${activity.team ?? ""}, ${START_HELP[activity.flow ?? "standard"] ?? START_HELP.standard}`}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
