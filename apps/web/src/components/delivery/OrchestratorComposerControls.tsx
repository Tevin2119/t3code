import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { PlayIcon, SaveIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEventHandler } from "react";

import {
  chosenTeamUnavailable,
  flowFor,
  flowStartLabel,
  parseTask,
  seatSettingsToSend,
  selectableTeams,
  teamListStatus,
  teamTaskBlock,
} from "../../lib/delivery";
import { cn } from "../../lib/utils";
import { matchingProjectBoard } from "../../lib/deliveryBoardPlacement";
import {
  useDeliveryAct,
  useDeliveryRead,
  useOrchestratorActivity,
  useOrchestratorDraft,
  useOrchestratorDraftStore,
  usePersonName,
} from "../../state/delivery";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useFlowPreview } from "./OrchestratorPanel";

const TEAMS_LOADING = "Teams are still loading.";

/** Keeps save/start handling mounted while configuration lives in the model picker. */
export function OrchestratorComposerControls(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: string;
  readonly workspace?: string | null;
  readonly prompt: string;
  readonly onPromptCleared: () => void;
}) {
  const navigate = useNavigate();
  const person = usePersonName();
  const draft = useOrchestratorDraft(props.threadId);
  const update = useOrchestratorDraftStore((state) => state.update);
  const reconcileTeam = useOrchestratorDraftStore((state) => state.reconcileTeam);
  const leave = useOrchestratorDraftStore((state) => state.leave);
  const setActivity = useOrchestratorDraftStore((state) => state.setActivity);
  const saveRequest = useOrchestratorDraftStore((state) => state.saveRequests[props.threadId] ?? 0);
  const startRequest = useOrchestratorDraftStore(
    (state) => state.startRequests[props.threadId] ?? 0,
  );
  const teamsRead = useDeliveryRead(props.environmentId, "/api/teams", { pollMs: 10_000 });
  const teams = selectableTeams(teamsRead.body);
  const teamsLoaded = teamListStatus(teamsRead) === "loaded";
  const awaitingTeams = draft?.awaitingTeams === true;
  // A new draft starts from the remembered team before the teams are read. Once
  // a reading offers any, prefer development if offered, else the first offered team, one time.
  useEffect(() => {
    if (!awaitingTeams || !teamsLoaded) return;
    reconcileTeam(
      props.threadId,
      teams.map((item) => item.team),
    );
  }, [awaitingTeams, props.threadId, reconcileTeam, teams, teamsLoaded]);
  const act = useDeliveryAct(props.environmentId, "orchestrator draft");
  const boardsRead = useDeliveryRead(props.environmentId, "/api/boards", { pollMs: 10_000 });
  const taskRead = useDeliveryRead(
    props.environmentId,
    draft?.engineThread ? `/api/tasks/${draft.engineThread}` : null,
  );
  const savedTask = parseTask(taskRead.body);
  const board =
    draft?.board !== undefined
      ? draft.board
      : draft?.engineThread
        ? (savedTask?.card.set ?? null)
        : matchingProjectBoard(boardsRead.body, props.workspace);
  const [busy, setBusy] = useState<"save" | "start" | null>(null);
  // Held from the press to the answer, so a second press cannot start a second workflow.
  const working = useRef(false);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);
  // The last action refused while teams were loading; settlement never replays it.
  const [pendingAttempt, setPendingAttempt] = useState<{
    threadId: string;
    action: "save" | "start";
  } | null>(null);
  // What the engine or a refused press said stays until the next attempt; the loading notice gives way to it.
  const report = (said: ReadonlyArray<string>) => {
    setPendingAttempt(null);
    setProblems(said);
  };

  const team = teams.find((candidate) => candidate.team === draft?.team) ?? null;
  // A draft still waiting may yet give its team up, so only a settled one is called unavailable.
  const teamAvailabilityReason =
    teamsLoaded && teams.length === 0
      ? "No teams are available to choose from."
      : chosenTeamUnavailable(teamsRead, draft)
        ? `Team ${draft?.team} is not offered here. Choose another team.`
        : null;
  const loadingBlock =
    awaitingTeams && props.environmentId !== null && !teamsRead.error && !teamAvailabilityReason;
  // Read while rendering, so the notice leaves as soon as loading is no longer what blocks.
  const loadingNotice = loadingBlock && pendingAttempt?.threadId === props.threadId;
  const resolved = flowFor(team, draft?.workflow ?? null);
  const flow =
    resolved === "standard"
      ? (team?.flows.find((item) => item.offered && item.id !== "standard")?.id ?? "chat")
      : resolved;
  const text = props.prompt.trim();
  const seatsToSend = team && draft ? seatSettingsToSend(team.settings, draft.seats) : {};
  const preview = useFlowPreview(props.environmentId, team?.team ?? null, flow, seatsToSend);
  const allFlows = preview?.flows ?? team?.flows ?? [];
  const chosen = allFlows.find((item) => item.id === flow) ?? null;
  const saved =
    draft?.engineThread == null ? "new" : text !== (draft.savedText ?? "") ? "changed" : "saved";
  const blocked = !props.environmentId
    ? "No environment is connected."
    : teamsRead.error
      ? `Delivery engine not reachable. ${teamsRead.error}`
      : teamAvailabilityReason
        ? teamAvailabilityReason
        : loadingBlock
          ? TEAMS_LOADING
          : team && teamTaskBlock(team, flow)
            ? teamTaskBlock(team, flow)
            : chosen && chosen.problems.length > 0
              ? chosen.problems.join(" ")
              : text.length === 0
                ? "Write what the team is asked to do."
                : null;
  const settledStartReason =
    pendingAttempt?.threadId === props.threadId &&
    pendingAttempt.action === "start" &&
    teamsLoaded &&
    !awaitingTeams &&
    props.environmentId !== null &&
    !teamsRead.error &&
    teamAvailabilityReason === null &&
    !loadingBlock
      ? blocked
      : null;

  useEffect(() => {
    setActivity(props.threadId, {
      busy,
      blocked,
      awaitingTeams,
      teamAvailabilityReason,
      team: draft?.team ?? null,
      saved,
      flow,
    });
  }, [
    awaitingTeams,
    blocked,
    busy,
    draft?.team,
    flow,
    props.threadId,
    saved,
    setActivity,
    teamAvailabilityReason,
  ]);

  const save = async (): Promise<string | null> => {
    if (!draft) return null;
    report([]);
    const body = {
      team: draft.team,
      workflow: flow,
      text,
      seats: seatsToSend,
      by: person,
      ...(!draft.engineThread && board ? { board } : {}),
      workspace:
        flow === "non-code" || (flow === "chat" && draft.useProjectFolder)
          ? (props.workspace ?? null)
          : null,
    };
    const result = draft.engineThread
      ? await act(`/api/tasks/${draft.engineThread}/edit`, body)
      : await act("/api/tasks", { ...body, draft: true });
    if (!result.ok) {
      report(result.problems.length > 0 ? result.problems : [result.why]);
      return null;
    }
    const task = parseTask(result.body);
    if (!task) {
      report(["The delivery engine answered with something that is not a task."]);
      return null;
    }
    update(props.threadId, { engineThread: task.id });
    if (draft.engineThread && draft.board !== undefined && draft.board !== task.card.set) {
      const placement = await act(`/api/tasks/${task.id}/board`, {
        board: draft.board,
        by: person,
      });
      if (!placement.ok) {
        report([placement.why]);
        return null;
      }
    }
    update(props.threadId, {
      savedText: text,
      board: draft.engineThread && draft.board === undefined ? task.card.set : board,
    });
    return task.id;
  };

  const once = async (kind: "save" | "start", work: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(kind);
    await work().finally(() => {
      working.current = false;
      setBusy(null);
    });
  };

  const { onPromptCleared, threadId } = props;
  const onSave = () => {
    if (text.length === 0) return;
    if (teamAvailabilityReason) return;
    // The team may still give way to another: nothing is saved under it until it is settled.
    if (awaitingTeams) {
      setProblems([]);
      setPendingAttempt({ threadId, action: "save" });
      return;
    }
    void once("save", async () => {
      await save();
    });
  };

  const onStart = () => {
    if (blocked) {
      if (loadingBlock) {
        setProblems([]);
        setPendingAttempt({ threadId, action: "start" });
      } else if (!teamAvailabilityReason) report([blocked]);
      return;
    }
    void once("start", async () => {
      const id = await save();
      if (!id) return;
      const result = await act(`/api/tasks/${id}/submit`, { by: person });
      if (!result.ok) {
        report(result.problems.length > 0 ? result.problems : [result.why]);
        return;
      }
      onPromptCleared();
      if (["chat", "non-code"].includes(flow)) {
        update(threadId, { started: true, workflow: flow });
        return;
      }
      leave(threadId);
      // What is written next is written on the task, in its own composer.
      void navigate({ to: "/board", search: { task: id } });
    });
  };

  // The buttons stand in the composer's own place for Send, and ask from there.
  // The composer keeps this component across threads while the counters are per
  // thread, so a thread change only takes the new thread's counter as handled.
  const handledSave = useRef({ threadId, request: saveRequest });
  useEffect(() => {
    const handled = handledSave.current;
    handledSave.current = { threadId, request: saveRequest };
    if (handled.threadId !== threadId || handled.request === saveRequest) return;
    onSave();
  }, [onSave, saveRequest, threadId]);
  const handledStart = useRef({ threadId, request: startRequest });
  useEffect(() => {
    const handled = handledStart.current;
    handledStart.current = { threadId, request: startRequest };
    if (handled.threadId !== threadId || handled.request === startRequest) return;
    onStart();
  }, [onStart, startRequest, threadId]);

  if (!draft) return null;

  const notice =
    teamAvailabilityReason ??
    (loadingNotice ? TEAMS_LOADING : (settledStartReason ?? problems.join(" ")));
  return notice ? (
    <span className="min-w-0 text-xs text-warning" data-delivery-orchestrator-status role="alert">
      {notice}
    </span>
  ) : null;
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
                className="flex items-center gap-1 text-3xs text-muted-foreground"
              />
            }
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                activity.saved === "saved"
                  ? "bg-success"
                  : activity.saved === "changed"
                    ? "bg-warning"
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
      {/* Round, like the start button beside it. */}
      <span className="flex shrink-0 [--control-radius:9999px]">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Save draft"
                disabled={
                  busy ||
                  activity.awaitingTeams ||
                  activity.teamAvailabilityReason !== null ||
                  !props.promptHasText
                }
                {...pointerFocusProps}
                onClick={() => requestSave(props.threadId)}
                data-delivery-save-draft
              />
            }
          >
            {activity.busy === "save" ? <Spinner className="size-3.5" /> : <SaveIcon />}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {activity.teamAvailabilityReason ??
              (activity.awaitingTeams
                ? TEAMS_LOADING
                : "Save draft. It is kept on the engine and nothing is started.")}
          </TooltipPopup>
        </Tooltip>
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="submit"
              className="relative flex h-9 w-9 items-center justify-center rounded-full bg-message-action text-message-action-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:shadow-message-action/24 enabled:inset-shadow-control-highlight hover:scale-105 hover:bg-message-action-hover disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none sm:h-8 sm:w-8"
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
