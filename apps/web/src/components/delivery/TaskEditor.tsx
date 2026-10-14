import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  PaperclipIcon,
  PlayIcon,
  SaveIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useThreadShell, useThreadProjection } from "../../state/entities";
import {
  parseCards,
  parseTarget,
  parseTask,
  targetLine,
  flowFor,
  flowStartLabel,
  parseTeams,
  seatIsOn,
  seatSettingsToSend,
  TASK_PRIORITIES,
  teamTaskBlock,
  type SeatChoice,
  type TaskFile,
  type TaskPriority,
  type TaskView,
} from "../../lib/delivery";
import {
  taskFromConversation,
  whatStartDoes,
  linesFromText,
  PRIORITY_LABEL,
  queryValue,
  tagsFromText,
} from "../../lib/deliveryBoard";
import { cn } from "../../lib/utils";
import {
  useDeliveryAct,
  useDeliveryRead,
  usePersonName,
  withSeatChoice,
} from "../../state/delivery";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { FlowChoice, useFlowPreview } from "./OrchestratorPanel";
import { InfoPopover } from "./InfoPopover";
import { SeatSettingsPanel } from "./SeatSettingsPanel";
import {
  AttachButton,
  FilesInTransit,
  TaskFileList,
  useFileIntake,
  useTaskUploads,
} from "./taskFiles";
import { BoardDialog, BoardPicker, type PickerItem } from "./BoardPicker";
import { PriorityPill } from "./taskParts";
import { TeamDefaultsDialog } from "./TeamDefaultsDialog";

interface Form {
  readonly title: string;
  readonly text: string;
  readonly requirements: string;
  readonly acceptance: string;
  readonly tags: string;
  readonly team: string;
  /** Empty until the team is read: the flow is then the one the team runs by default. */
  readonly flow: string;
  /** Null until a person chooses: triage sets it then. */
  readonly priority: TaskPriority | null;
  readonly deadline: string;
  readonly seats: Readonly<Record<string, SeatChoice>>;
}

/** The value of the board choice for a task on no board. */
const NO_BOARD = "__no_board__";

const EMPTY: Form = {
  title: "",
  text: "",
  requirements: "",
  acceptance: "",
  tags: "",
  team: "development",
  flow: "",
  priority: null,
  deadline: "",
  seats: {},
};

const formOf = (task: TaskView): Form => ({
  title: task.title === "Untitled draft" ? "" : task.title,
  text: task.body,
  requirements: task.requirements.join("\n"),
  acceptance: task.acceptance.join("\n"),
  tags: task.tags.join(", "),
  team: task.team,
  flow: task.workflow,
  priority: task.priorityBy === "person" ? task.priority : null,
  deadline: task.deadline ? task.deadline.slice(0, 10) : "",
  seats: Object.fromEntries(task.settings.map((item) => [item.seat, item.set])),
});

function Field(props: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium">{props.label}</span>
      {props.children}
      {props.hint ? <span className="text-2xs text-muted-foreground">{props.hint}</span> : null}
    </label>
  );
}

/**
 * Where a task is written: what is asked, what it must meet, how it is known
 * to be done, and anything that helps. Saved as a draft it asks nothing of
 * anyone. Submitted, the team takes it on and the engine moves it from there.
 */
export function TaskEditor(props: {
  readonly environmentId: EnvironmentId | null;
  /** A draft that was saved before, or null for a new task. */
  readonly taskId: string | null;
  readonly from: "Board" | "Orchestrator";
  readonly onClose: () => void;
  /** Called with the task's id once it has one, and again when it is submitted. */
  readonly onSaved: (taskId: string) => void;
  /** A conversation of the window this new task is made from: `<environment>/<thread>`. */
  readonly fromConversation?: string | null;
  /** A board of the person's own that is chosen: a new task is filed onto it. */
  readonly board?: { readonly id: string; readonly title: string } | null;
}) {
  const person = usePersonName();
  const navigate = useNavigate();
  const conversationRef = useMemo(() => {
    const ref = props.taskId ? null : (props.fromConversation ?? null);
    if (!ref) return null;
    const [environmentId, threadId] = ref.split("/");
    return environmentId && threadId
      ? scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId))
      : null;
  }, [props.fromConversation, props.taskId]);
  const conversationShell = useThreadShell(conversationRef);
  const conversationDetail = useThreadProjection(conversationRef);
  const conversation =
    conversationShell && conversationDetail
      ? { title: conversationShell.title, messages: conversationDetail.projection.messages }
      : null;
  const act = useDeliveryAct(props.environmentId, "task draft");
  const teamsRead = useDeliveryRead(props.environmentId, "/api/teams");
  const teams = useMemo(
    () => parseTeams(teamsRead.body).filter((team) => team.team !== "triage"),
    [teamsRead.body],
  );
  const taskRead = useDeliveryRead(
    props.environmentId,
    props.taskId ? `/api/tasks/${props.taskId}` : null,
  );
  const saved = useMemo(() => parseTask(taskRead.body), [taskRead.body]);

  const [form, setForm] = useState<Form>(EMPTY);
  const [clean, setClean] = useState<Form>(EMPTY);
  // A saved draft is loaded into the form once, when it is opened.
  const [loaded, setLoaded] = useState<string | null>(null);
  if (saved && saved.isDraft && loaded !== saved.id) {
    setLoaded(saved.id);
    setForm(formOf(saved));
    setClean(formOf(saved));
  }
  // A new task made from a conversation is written from it once, for the person to review.
  const conversationKey = conversationRef ? `conversation:${props.fromConversation}` : null;
  if (conversationKey && conversation && loaded !== conversationKey) {
    setLoaded(conversationKey);
    const made = taskFromConversation({
      title: conversation.title,
      ref: props.fromConversation ?? "",
      messages: conversation.messages,
    });
    setForm({ ...EMPTY, title: made.title, text: made.text });
  }
  // The board the task goes on: the one chosen on the Board if it is a person's own, else none.
  const boardsRead = useDeliveryRead(props.environmentId, "/api/boards");
  const boards = useMemo(
    () =>
      (Array.isArray(boardsRead.body) ? boardsRead.body : []).flatMap((item: unknown) =>
        item && typeof item === "object" && "id" in item && "title" in item
          ? [
              {
                id: String(item.id),
                title: String(item.title),
                description: "description" in item ? String(item.description ?? "") : "",
                kind: "own" as const,
                target: "target" in item ? parseTarget(item.target) : null,
              },
            ]
          : [],
      ),
    [boardsRead.body],
  );
  const [boardChoice, setBoardChoice] = useState<string | null>(null);
  // A saved task keeps its own target; a new one takes the chosen board's.
  const chosenBoardTarget = boards.find((item) => item.id === boardChoiceNow())?.target ?? null;
  function boardChoiceNow() {
    return boardChoice ?? (saved ? (saved.card.set ?? "") : (props.board?.id ?? ""));
  }
  const taskTarget = saved ? saved.target : chosenBoardTarget;
  // A saved draft put on a board bound elsewhere may take that board's target, when a person says so.
  const retargetTo =
    saved &&
    saved.state === "draft" &&
    chosenBoardTarget?.ok &&
    (chosenBoardTarget.repository !== saved.target?.repository ||
      chosenBoardTarget.base !== saved.target?.base)
      ? chosenBoardTarget
      : null;
  const retarget = async () => {
    if (!props.taskId || !retargetTo) return;
    const result = await act(`/api/tasks/${props.taskId}/target`, {
      repository: retargetTo.repository,
      base: retargetTo.base,
      by: person,
    });
    if (!result.ok) setProblems([result.why]);
    taskRead.refresh();
  };
  // A board made or edited from the form, as on the Board.
  const [boardDialog, setBoardDialog] = useState<{ readonly editing: PickerItem | null } | null>(
    null,
  );
  const [boardBusy, setBoardBusy] = useState(false);
  const [boardProblem, setBoardProblem] = useState<string | null>(null);
  const saveBoard = async (input: {
    readonly title: string;
    readonly description: string;
    readonly repository?: string;
    readonly base?: string;
  }) => {
    setBoardBusy(true);
    setBoardProblem(null);
    const editing = boardDialog?.editing ?? null;
    const result = await act(editing ? `/api/boards/${editing.id}/edit` : "/api/boards", {
      ...input,
      by: person,
    });
    setBoardBusy(false);
    if (!result.ok) {
      setBoardProblem(result.why);
      return;
    }
    const made = result.body as { readonly id?: string } | null;
    // A board made here is the one the task goes on.
    if (!editing && made?.id) setBoardChoice(made.id);
    setBoardDialog(null);
    boardsRead.refresh();
  };
  const removeBoard = async () => {
    const editing = boardDialog?.editing ?? null;
    if (!editing) return;
    setBoardBusy(true);
    const result = await act(`/api/boards/${editing.id}/remove`, { by: person });
    setBoardBusy(false);
    if (!result.ok) {
      setBoardProblem(result.why);
      return;
    }
    if (boardNow === editing.id) setBoardChoice("");
    setBoardDialog(null);
    boardsRead.refresh();
  };
  const boardNow = boardChoice ?? (saved ? (saved.card.set ?? "") : (props.board?.id ?? ""));
  const [busy, setBusy] = useState<"save" | "submit" | null>(null);
  const working = useRef(false);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);
  const [showSeats, setShowSeats] = useState(false);
  const [editingDefaults, setEditingDefaults] = useState(false);
  const [related, setRelated] = useState("");
  const [pendingLinks, setPendingLinks] = useState<
    ReadonlyArray<{ id: string; number: number; title: string }>
  >([]);
  const uploads = useTaskUploads(props.environmentId, person);

  const team = teams.find((candidate) => candidate.team === form.team) ?? null;
  const flow = flowFor(team, form.flow || null);
  const settings = saved?.team === form.team ? saved.settings : (team?.settings ?? []);
  const seatsToSend = seatSettingsToSend(settings, form.seats);
  const preview = useFlowPreview(props.environmentId, team?.team ?? null, flow, seatsToSend);
  const flows = preview?.flows ?? team?.flows ?? [];
  const chosenFlow = flows.find((item) => item.id === flow) ?? null;
  const seatsOn = settings.filter((item) => seatIsOn(item, form.seats[item.seat] ?? {})).length;
  const changed = JSON.stringify(form) !== JSON.stringify(clean);
  const set = (patch: Partial<Form>) => setForm((current) => ({ ...current, ...patch }));

  const lookup = useDeliveryRead(
    props.environmentId,
    related.trim().length >= 2
      ? `/api/tasks?q=${queryValue(related.trim())}&limit=6&set=all`
      : null,
  );
  const found = useMemo(
    () => parseCards(lookup.body).filter((card) => card.id !== props.taskId),
    [lookup.body, props.taskId],
  );

  const payload = () => ({
    title: form.title.trim(),
    text: form.text.trim(),
    requirements: linesFromText(form.requirements),
    acceptance: linesFromText(form.acceptance),
    tags: tagsFromText(form.tags),
    team: form.team,
    ...(form.priority ? { priority: form.priority } : {}),
    deadline: form.deadline ? new Date(`${form.deadline}T12:00:00`).toISOString() : null,
    seats: seatsToSend,
    workflow: flow,
    by: person,
    // Where it came from goes with it, so the task and the conversation lead to each other.
    ...(conversationRef && !props.taskId ? { origin: `thread:${props.fromConversation}` } : {}),
    ...(!props.taskId && boardNow ? { board: boardNow } : {}),
  });

  /** Saves the draft and answers with its id, or null when the engine refused. */
  const save = async (): Promise<string | null> => {
    setProblems([]);
    const result = props.taskId
      ? await act(`/api/tasks/${props.taskId}/edit`, payload())
      : await act("/api/tasks", {
          ...payload(),
          draft: true,
          related: pendingLinks.map((link) => link.id),
        });
    if (!result.ok) {
      setProblems(result.problems.length > 0 ? result.problems : [result.why]);
      return null;
    }
    const task = parseTask(result.body);
    if (!task) {
      setProblems(["The delivery engine answered with something that is not a task."]);
      return null;
    }
    if (props.taskId && boardChoice !== null && boardChoice !== (saved?.card.set ?? "")) {
      const moved = await act(`/api/tasks/${task.id}/board`, {
        board: boardChoice || null,
        by: person,
      });
      if (!moved.ok) {
        setProblems([moved.why]);
        return null;
      }
    }
    setClean(form);
    taskRead.refresh();
    return task.id;
  };

  const once = async (kind: "save" | "submit", work: () => Promise<void>) => {
    // One at a time: a second press while the first is on its way does nothing.
    if (working.current) return;
    working.current = true;
    setBusy(kind);
    try {
      await work();
    } finally {
      working.current = false;
      setBusy(null);
    }
  };

  const onSave = () =>
    once("save", async () => {
      const id = await save();
      if (id && id !== props.taskId) props.onSaved(id);
    });

  const onSubmit = () =>
    once("submit", async () => {
      const id = await save();
      if (!id) return;
      const result = await act(`/api/tasks/${id}/submit`, { by: person });
      if (!result.ok) {
        setProblems(result.problems.length > 0 ? result.problems : [result.why]);
        // The draft was saved, so it is what is shown from here on.
        if (id !== props.taskId) props.onSaved(id);
        return;
      }
      props.onSaved(id);
    });

  const attach = (files: File[]) =>
    once("save", async () => {
      // A file belongs to a task, so the draft is saved first.
      const id = props.taskId ?? (await save());
      if (!id) return;
      await Promise.all(files.map((file) => uploads.send(id, file)));
      taskRead.refresh();
      if (id !== props.taskId) props.onSaved(id);
    });
  const intake = useFileIntake((files) => void attach(files));

  const removeFile = async (file: TaskFile) => {
    if (!props.taskId) return;
    const result = await act(`/api/tasks/${props.taskId}/files/remove`, {
      file: file.id,
      by: person,
    });
    if (!result.ok) setProblems([result.why]);
    taskRead.refresh();
  };

  const link = async (other: { id: string; number: number; title: string }, remove = false) => {
    setRelated("");
    if (!props.taskId) {
      setPendingLinks((current) =>
        remove
          ? current.filter((item) => item.id !== other.id)
          : current.some((item) => item.id === other.id)
            ? current
            : [...current, other],
      );
      return;
    }
    const result = await act(`/api/tasks/${props.taskId}/links`, {
      other: other.id,
      kind: "related",
      by: person,
      remove,
    });
    if (!result.ok) setProblems([result.why]);
    taskRead.refresh();
  };
  const links = props.taskId
    ? (saved?.links ?? []).filter((item) => item.direction === "out")
    : pendingLinks;

  const teamBlock = team
    ? (teamTaskBlock(team, flow) ??
      (chosenFlow && chosenFlow.problems.length > 0 ? chosenFlow.problems.join(" ") : null))
    : null;
  // Nothing is submitted without a repository it can be done in: there is no fallback.
  // Both the flag and the repository: a target is usable only when it names one and it works.
  const targetBlock =
    taskTarget?.ok &&
    (taskTarget.repository || (["chat", "non-code"].includes(flow) && taskTarget.path))
      ? null
      : saved && taskTarget?.repository
        ? `${targetLine(taskTarget)}. The task keeps this target: put it on a board whose repository works and press Use, or fix the repository.`
        : `${targetLine(taskTarget)}. Choose a board bound to a repository first.`;
  const canSubmit =
    form.text.trim().length > 0 && teamBlock === null && targetBlock === null && busy === null;
  const engineDown = teamsRead.error ?? taskRead.error;
  const state = !props.taskId ? "Not saved yet" : changed ? "Changed since it was saved" : "Saved";

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none  ">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-task-editor {...intake.handlers}>
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 py-2">
            <Button size="xs" variant="ghost" onClick={props.onClose}>
              <ArrowLeftIcon />
              {props.from}
            </Button>
            <h1 className="text-sm font-medium">{saved ? `Draft #${saved.number}` : "New task"}</h1>
            <span className="text-xs text-muted-foreground" data-task-editor-state>
              {state}. Nothing runs for a draft.
            </span>
            <InfoPopover label="What Submit does" marker={{ "data-delivery-what-starts": flow }}>
              {whatStartDoes(flow, "Submit")}
            </InfoPopover>

            {conversationRef ? (
              <p
                className="order-last w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
                data-task-editor-conversation
              >
                {conversation ? (
                  <>
                    Made from the conversation{" "}
                    <button
                      type="button"
                      className="text-primary underline-offset-2 hover:underline"
                      onClick={() =>
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: {
                            environmentId: conversationRef.environmentId,
                            threadId: conversationRef.threadId,
                          },
                        })
                      }
                    >
                      {conversation.title}
                    </button>
                    . The summary below was written from it as it stands: read it and change what is
                    not right. The task keeps a link to the conversation.
                  </>
                ) : (
                  "Reading the conversation this task is made from…"
                )}
              </p>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              {props.taskId ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`/api/tasks/${props.taskId}/discard`, {}).then((result) =>
                      result.ok ? props.onClose() : setProblems([result.why]),
                    )
                  }
                >
                  Discard draft
                </Button>
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="outline"
                      aria-label="Save draft"
                      disabled={busy !== null || Boolean(engineDown)}
                      onClick={() => void onSave()}
                      data-task-save-draft
                    />
                  }
                >
                  <SaveIcon />
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  Save draft. It is kept on the engine and asks nothing of anyone.
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      disabled={!canSubmit || Boolean(engineDown)}
                      onClick={() => void onSubmit()}
                      data-task-submit
                    />
                  }
                >
                  <PlayIcon />
                  {busy === "submit"
                    ? "Starting"
                    : flow === "standard"
                      ? "Submit"
                      : flowStartLabel(flow)}
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  {teamBlock
                    ? teamBlock
                    : targetBlock
                      ? targetBlock
                      : form.text.trim().length === 0
                        ? "Write what is asked first."
                        : `Saves it and gives it to team ${form.team}. ${chosenFlow?.summary ?? ""}`}
                </TooltipPopup>
              </Tooltip>
            </div>
          </div>
        </WorkspacePageHeader>

        {engineDown ? (
          <p className="px-5 pt-3 text-sm text-warning">
            Delivery engine not reachable. {engineDown}
          </p>
        ) : null}
        {problems.length > 0 ? (
          <ul className="list-disc px-9 pt-3 text-sm text-warning" data-delivery-problem>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}

        <ScrollArea className="min-h-0 flex-1">
          <div
            className={cn(
              "mx-auto grid w-full max-w-6xl gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_20rem]",
              intake.over && "outline-2 -outline-offset-8 outline-ring outline-dashed",
            )}
          >
            <div className="flex min-w-0 flex-col gap-4">
              <Field label="Title">
                <Input
                  aria-label="Title"
                  placeholder="A short name for the task"
                  value={form.title}
                  onChange={(event) => set({ title: event.target.value })}
                />
              </Field>
              <Field
                label="What is asked"
                hint="Paste or drop files anywhere on this page: screenshots, recordings, logs."
              >
                <Textarea
                  aria-label="What is asked"
                  placeholder="What is to be done, and why"
                  className="min-h-40"
                  value={form.text}
                  onChange={(event) => set({ text: event.target.value })}
                />
              </Field>
              <Field label="Requirements" hint="One to a line. What the work has to keep to.">
                <Textarea
                  aria-label="Requirements"
                  placeholder={"Works on Windows and Linux\nNo new dependency"}
                  className="min-h-24"
                  value={form.requirements}
                  onChange={(event) => set({ requirements: event.target.value })}
                />
              </Field>
              <Field
                label="Acceptance criteria"
                hint="One to a line. How it is known to be done. QA tests against these."
              >
                <Textarea
                  aria-label="Acceptance criteria"
                  placeholder={"The command prints the version\nA test covers it"}
                  className="min-h-24"
                  value={form.acceptance}
                  onChange={(event) => set({ acceptance: event.target.value })}
                />
              </Field>
              <section className="flex flex-col gap-2">
                <div className="flex items-center gap-1">
                  <h2 className="text-xs font-medium">Attachments</h2>
                  <AttachButton
                    label="Attach files"
                    disabled={busy !== null}
                    onFiles={(files) => void attach(files)}
                  >
                    <PaperclipIcon />
                  </AttachButton>
                </div>
                <TaskFileList
                  environmentId={props.environmentId}
                  files={saved?.files ?? []}
                  onRemove={(file) => void removeFile(file)}
                />
                <FilesInTransit transit={uploads.transit} onDismiss={uploads.dismiss} />
                {(saved?.files.length ?? 0) === 0 && uploads.transit.length === 0 ? (
                  <p className="text-2xs text-muted-foreground">
                    None yet. The team is pointed at every file attached here.
                  </p>
                ) : null}
              </section>
            </div>

            <aside className="flex min-w-0 flex-col gap-4">
              {saved?.card.set === "qualification" ? null : (
                <div className="flex flex-col gap-1" data-task-editor-board={boardNow}>
                  <span className="text-xs font-medium">Board</span>
                  {/* The Board's own picker: the boards to file onto, and a new one made here. */}
                  <BoardPicker
                    label="Task board"
                    marker="task-board"
                    look="field"
                    noneYet="You have no boards yet. New board… makes one, named for the work it groups, and puts this task on it."
                    items={[
                      {
                        id: NO_BOARD,
                        title: "Not on a board",
                        description:
                          "The default. The task shows under Not on a board until you put it on one.",
                        kind: "built-in",
                      },
                      ...boards,
                    ]}
                    value={boardNow || NO_BOARD}
                    newLabel="New board…"
                    onChoose={(id) => setBoardChoice(id === NO_BOARD ? "" : id)}
                    onCreate={() => setBoardDialog({ editing: null })}
                    onEdit={(item) => setBoardDialog({ editing: item })}
                  />
                  <span className="text-2xs text-muted-foreground">
                    Where the task will show once saved or submitted. It can be moved later.
                  </span>
                  {/* Where the work is done: taken from the board when the task is made, and kept. */}
                  <div
                    className="flex flex-col gap-1 rounded-md border border-border px-2 py-1.5"
                    data-task-editor-target={taskTarget?.ok ? "ok" : "none"}
                  >
                    <span className="text-xs font-medium">Repository · base branch</span>
                    <span
                      className={`text-xs ${taskTarget?.ok ? "" : "text-warning"}`}
                      data-task-editor-target-line
                    >
                      {targetLine(taskTarget)}
                    </span>
                    {taskTarget?.ok && taskTarget.path ? (
                      <span className="truncate font-mono text-2xs text-muted-foreground">
                        {taskTarget.path}
                      </span>
                    ) : null}
                    <span className="text-2xs text-muted-foreground">
                      {saved
                        ? "Kept by the task. Moving it to another board does not change it."
                        : taskTarget?.repository
                          ? "Taken from the board. The team works in a worktree of its own from this branch."
                          : "Choose a board bound to a repository. A task is not submitted without one."}
                    </span>
                    {retargetTo ? (
                      <Button
                        size="xs"
                        variant="outline"
                        className="self-start"
                        disabled={busy !== null}
                        onClick={() => void retarget()}
                        data-task-editor-retarget
                      >
                        Use {targetLine(retargetTo)}
                      </Button>
                    ) : null}
                  </div>
                  {boardDialog ? (
                    <BoardDialog
                      kind="board"
                      editing={boardDialog.editing}
                      environmentId={props.environmentId}
                      by={person}
                      busy={boardBusy}
                      problem={boardProblem}
                      onClose={() => {
                        setBoardDialog(null);
                        setBoardProblem(null);
                      }}
                      onSave={(input) => void saveBoard(input)}
                      onRemove={() => void removeBoard()}
                    />
                  ) : null}
                </div>
              )}
              <Field label="Team">
                <Select
                  value={form.team}
                  onValueChange={(value) => set({ team: String(value), seats: {}, flow: "" })}
                >
                  <SelectTrigger aria-label="Team" size="compact">
                    <SelectValue>{form.team}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {teams.map((item) => (
                      <SelectItem
                        key={item.team}
                        value={item.team}
                        disabled={teamTaskBlock(item) !== null}
                      >
                        <span className="flex max-w-80 flex-col">
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
              </Field>
              <section className="flex flex-col gap-1">
                <h2 className="text-xs font-medium">Flow</h2>
                <FlowChoice flows={flows} value={flow} onChange={(next) => set({ flow: next })} />
                {chosenFlow && chosenFlow.problems.length > 0 ? (
                  <ul className="list-disc pl-5 text-2xs text-warning" data-flow-problems>
                    {chosenFlow.problems.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
              </section>
              <Field
                label="Priority"
                hint={
                  form.priority ? undefined : "Left to triage, which sets it from what is asked."
                }
              >
                <Select
                  value={form.priority ?? "__triage__"}
                  onValueChange={(value) =>
                    set({ priority: value === "__triage__" ? null : (value as TaskPriority) })
                  }
                >
                  <SelectTrigger aria-label="Priority" size="compact">
                    <SelectValue>
                      {form.priority ? <PriorityPill priority={form.priority} /> : "Set by triage"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    <SelectItem value="__triage__">Set by triage</SelectItem>
                    {TASK_PRIORITIES.map((priority) => (
                      <SelectItem key={priority} value={priority}>
                        {PRIORITY_LABEL[priority]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field label="Tags" hint="Separated by commas. Tasks are grouped and found by them.">
                <Input
                  aria-label="Tags"
                  placeholder="engine, windows"
                  value={form.tags}
                  onChange={(event) => set({ tags: event.target.value })}
                />
              </Field>
              <Field label="Wanted by">
                <Input
                  aria-label="Wanted by"
                  type="date"
                  value={form.deadline}
                  onChange={(event) => set({ deadline: event.target.value })}
                />
              </Field>

              <section className="flex flex-col gap-1">
                <h2 className="text-xs font-medium">Related tasks</h2>
                <ul className="flex flex-col gap-1 text-xs">
                  {links.map((item) => (
                    <li key={item.id} className="flex items-center gap-1">
                      <span className="font-mono text-3xs text-muted-foreground">
                        #{item.number}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      <button
                        type="button"
                        aria-label={`Remove the link to #${item.number}`}
                        className="cursor-pointer text-muted-foreground hover:text-foreground"
                        onClick={() => void link(item, true)}
                      >
                        <XIcon className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
                <Input
                  aria-label="Find a task to relate"
                  placeholder="Find by #number or title"
                  value={related}
                  onChange={(event) => setRelated(event.target.value)}
                />
                {related.trim().length >= 2 ? (
                  <ul className="flex flex-col rounded-md border border-border text-xs">
                    {found.length === 0 ? (
                      <li className="px-2 py-1 text-muted-foreground">No task found.</li>
                    ) : (
                      found.map((card) => (
                        <li key={card.id}>
                          <button
                            type="button"
                            className="flex w-full cursor-pointer items-center gap-1 px-2 py-1 text-left hover:bg-accent"
                            onClick={() => void link(card)}
                          >
                            <span className="font-mono text-3xs text-muted-foreground">
                              #{card.number}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{card.title}</span>
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                ) : null}
              </section>

              <section className="flex flex-col gap-2 rounded-md border border-border p-2">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="flex cursor-pointer items-center gap-1 text-xs font-medium"
                    aria-expanded={showSeats}
                    onClick={() => setShowSeats((current) => !current)}
                    data-task-editor-seats
                  >
                    <Settings2Icon className="size-3.5" />
                    Seats
                    <span className="font-normal text-muted-foreground">
                      {seatsOn} of {settings.length} on
                      {Object.keys(seatsToSend).length > 0
                        ? `, ${Object.keys(seatsToSend).length} set for this task`
                        : ", all on the team default"}
                    </span>
                  </button>
                  <Button size="xs" variant="ghost" onClick={() => setEditingDefaults(true)}>
                    Team defaults
                  </Button>
                </div>
                {showSeats ? (
                  <SeatSettingsPanel
                    environmentId={props.environmentId}
                    settings={settings}
                    chosen={form.seats}
                    taking={chosenFlow?.seats}
                    onChange={(seat, choice) =>
                      set({ seats: withSeatChoice(form.seats, seat, choice) })
                    }
                  />
                ) : null}
              </section>
            </aside>
          </div>
        </ScrollArea>
      </div>
      {editingDefaults ? (
        <TeamDefaultsDialog
          environmentId={props.environmentId}
          team={form.team}
          onClose={() => setEditingDefaults(false)}
          onSaved={() => {
            teamsRead.refresh();
            taskRead.refresh();
          }}
        />
      ) : null}
    </SidebarInset>
  );
}
