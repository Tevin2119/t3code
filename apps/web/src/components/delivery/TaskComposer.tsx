import * as Schema from "effect/Schema";
import type { EnvironmentId } from "@t3tools/contracts";
import { CornerDownRightIcon, PaperclipIcon, PencilIcon, SendIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { usePrimarySettings } from "../../hooks/useSettings";
import type { TaskFile, TaskView, TimelineEntry } from "../../lib/delivery";
import {
  COMPOSER_EFFECT,
  COMPOSER_KIND_HELP,
  COMPOSER_KIND_LABEL,
  isSendKey,
  type ComposerKind,
} from "../../lib/deliveryBoard";
import { cn } from "../../lib/utils";
import { useDeliveryAct, usePersonName } from "../../state/delivery";
import {
  EMPTY_REPLY,
  replyDraftKey,
  useDeliveryReplyDrafts,
} from "../../state/deliveryReplyDrafts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  AttachButton,
  FilesInTransit,
  TaskFileList,
  useFileIntake,
  useTaskUploads,
} from "./taskFiles";
import { MobileHelp } from "./taskParts";

const composerKindSchema = Schema.Literals(["message", "note", "change", "status", "answer"]);
const draftFilesSchema = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    type: Schema.String,
    size: Schema.Number,
    by: Schema.String,
    at: Schema.String,
    message: Schema.NullOr(Schema.Number),
    path: Schema.String,
  }),
);

export function TaskComposer(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: TaskView;
  readonly replyTo: TimelineEntry | null;
  readonly onReplyTo: (entry: TimelineEntry | null) => void;
  readonly onSent: () => void;
  readonly onReplySent?: (seq: number) => void;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
}) {
  const { task } = props;
  const person = usePersonName();
  const sendShortcut = usePrimarySettings((settings) => settings.sendShortcut);
  const act = useDeliveryAct(props.environmentId, "task message");
  const uploads = useTaskUploads(props.environmentId, person);
  const [messageText, setMessageText] = useLocalStorage(
    `t3code:task-message:${JSON.stringify([props.environmentId, task.id])}`,
    "",
    Schema.String,
  );
  const draftKey = replyDraftKey(props.environmentId ?? "", task.id, props.replyTo?.seq ?? -1);
  const answerDraft = useDeliveryReplyDrafts((state) => state.drafts[draftKey] ?? EMPTY_REPLY);
  const replyPending = useDeliveryReplyDrafts((state) => state.pending[draftKey] === true);
  const updateDraft = useDeliveryReplyDrafts((state) => state.update);
  const beginReply = useDeliveryReplyDrafts((state) => state.begin);
  const finishReply = useDeliveryReplyDrafts((state) => state.finish);
  const discardReply = useDeliveryReplyDrafts((state) => state.discard);
  const text = props.replyTo ? answerDraft.text : messageText;
  const setText = (value: string) =>
    props.replyTo ? updateDraft(draftKey, { text: value }) : setMessageText(value);
  const [chosen, setChosen] = useLocalStorage(
    `t3code:task-message-kind:${JSON.stringify([props.environmentId, task.id])}`,
    "message" as ComposerKind,
    composerKindSchema,
  );
  const [files, setFiles] = useLocalStorage(
    `t3code:task-draft-files:${JSON.stringify([props.environmentId, task.id, props.replyTo?.seq ?? null])}`,
    [] as ReadonlyArray<TaskFile>,
    draftFilesSchema,
  );
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [problem, setProblem] = useState<{ target: number | null; text: string } | null>(null);

  const waits = task.questions.at(-1) ?? null;
  const replying = props.replyTo;
  const kind: ComposerKind = replying ? "answer" : chosen === "answer" ? "message" : chosen;
  const staleReply =
    replying !== null && !task.questions.some((question) => question.seq === replying.seq);
  // A chat has nothing that is asked of the team to change: what is written is the conversation.
  const chat = task.workflow === "chat";
  const kinds: ReadonlyArray<ComposerKind> = [
    ...(waits ? (["answer"] as const) : []),
    ...(chat
      ? (["message", "note", "status"] as const)
      : (["message", "note", "change", "status"] as const)),
  ];
  const help = (item: ComposerKind) =>
    chat && item === "message"
      ? "Read by the seat that leads the chat, which answers, or brings in the seats it concerns. Each answers under its own name."
      : COMPOSER_KIND_HELP[item];
  const closed = task.state === "rejected" || task.state === "closed";

  const attach = async (picked: File[]) => {
    const sent = await Promise.all(picked.map((file) => uploads.send(task.id, file)));
    setFiles((current) => [...current, ...sent.filter((file): file is TaskFile => file !== null)]);
  };
  const intake = useFileIntake((picked) => void attach(picked));
  const uploading = uploads.transit.some((item) => item.problem === null);
  const canSend =
    props.environmentId !== null &&
    !busy &&
    !uploading &&
    !closed &&
    !staleReply &&
    !(replying && (answerDraft.uncertain || replyPending)) &&
    (text.trim().length > 0 || files.length > 0);

  const send = async () => {
    if (!canSend || sending.current) return;
    if (replying && !beginReply(draftKey)) return;
    sending.current = true;
    setBusy(true);
    setProblem(null);
    const result = await act(`/api/tasks/${task.id}/messages`, {
      text: text.trim(),
      kind,
      ...(replying ? { replyTo: replying.seq } : {}),
      files: files.map((file) => file.id),
      by: person,
    });
    if (replying) {
      const rejected =
        !result.ok && result.status !== null && result.status >= 400 && result.status < 500;
      finishReply(draftKey, result.ok ? "accepted" : rejected ? "rejected" : "unknown");
    }
    sending.current = false;
    setBusy(false);
    props.onSent();
    if (!result.ok) {
      setProblem({ target: replying?.seq ?? null, text: result.why });
      return;
    }
    if (!replying) setMessageText("");
    setFiles([]);
    setChosen("message");
    if (replying && props.onReplySent) props.onReplySent(replying.seq!);
    else props.onReplyTo(null);
  };
  const effect = COMPOSER_EFFECT[kind];

  return (
    <div
      className={cn(
        "flex min-h-0 shrink-0 flex-col border-t border-border p-2 [@media(min-width:640px)_and_(min-height:600px)]:p-3",
        intake.over && "outline-2 -outline-offset-4 outline-ring outline-dashed",
      )}
      data-task-composer
      {...intake.handlers}
    >
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0 justify-start [@media(min-width:640px)_and_(min-height:600px)]:hidden"
        aria-expanded={props.expanded}
        aria-controls={`composer-${task.id}`}
        onClick={() => props.onExpandedChange(!props.expanded)}
        data-task-composer-toggle
      >
        <PencilIcon />
        {props.expanded
          ? "Hide message"
          : text.trim() || files.length
            ? "Continue draft"
            : "Write to the team"}
      </Button>
      <div
        id={`composer-${task.id}`}
        className={cn(
          "min-h-0 flex-col gap-2 overflow-y-auto [@media(min-width:640px)_and_(min-height:600px)]:flex",
          props.expanded ? "flex" : "hidden",
        )}
      >
        {problem && problem.target === (replying?.seq ?? null) ? (
          <p className="text-sm text-warning" data-delivery-problem>
            {problem.text}
          </p>
        ) : null}
        {staleReply || (replying && answerDraft.uncertain) ? (
          <p role="alert" className="text-xs text-warning">
            {staleReply
              ? "This question is no longer waiting. Your draft is kept and cannot be sent."
              : "Delivery is unconfirmed. Check the engine record before discarding this draft; it will not be sent again automatically."}
          </p>
        ) : null}
        {replying && (answerDraft.uncertain || staleReply) && !replyPending ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              discardReply(draftKey);
              setFiles([]);
              props.onReplyTo(null);
            }}
          >
            Discard draft
          </Button>
        ) : null}
        {replying ? (
          <p
            className="flex items-start gap-1 rounded border border-warning/60 bg-warning/5 px-2 py-1 text-xs"
            data-task-composer-reply
          >
            <CornerDownRightIcon className="mt-0.5 size-3 shrink-0" />
            {/* Two lines are enough to say which question: the whole of it is in the history above. */}
            <span className="line-clamp-2 min-w-0 flex-1">
              Answering {replying.by}:{" "}
              <span className="text-muted-foreground">{replying.text}</span>
            </span>
            <button
              type="button"
              aria-label="Do not answer this question"
              className="cursor-pointer"
              onClick={() => {
                props.onReplyTo(null);
                setChosen("message");
              }}
            >
              <XIcon className="size-3" />
            </button>
          </p>
        ) : waits ? (
          <p className="text-xs text-warning-foreground">
            A question of {waits.by} waits for you. Choose Answer a question below, or press Answer
            on it.
          </p>
        ) : null}
        <Textarea
          aria-label="Message on the task"
          placeholder={
            closed
              ? "This is closed. What was said is kept."
              : kind === "answer"
                ? "Your answer"
                : kind === "status"
                  ? "What do you want to know? The record is read out."
                  : kind === "change"
                    ? "What is to change in what is asked"
                    : kind === "note"
                      ? "A note for the record"
                      : "Write to the team. Paste or drop files here."
          }
          disabled={closed || busy || replyPending}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (isSendKey(event.nativeEvent, sendShortcut, text)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <TaskFileList
          environmentId={props.environmentId}
          files={files}
          compact
          onRemove={(file) => setFiles((current) => current.filter((item) => item.id !== file.id))}
        />
        <FilesInTransit transit={uploads.transit} onDismiss={uploads.dismiss} />
        <div className="flex items-center gap-1">
          <AttachButton
            label="Attach files"
            disabled={closed}
            onFiles={(picked) => void attach(picked)}
          >
            <PaperclipIcon />
          </AttachButton>
          {props.replyTo ? (
            <Badge size="sm" variant="outline">
              {COMPOSER_KIND_LABEL.answer}
            </Badge>
          ) : (
            <Select
              value={kind}
              onValueChange={(value) => {
                if (value === "answer") {
                  const target = task.timeline.find(
                    (entry) => entry.seq === waits?.seq && entry.kind === "question",
                  );
                  if (target) props.onReplyTo(target);
                } else setChosen(value as ComposerKind);
              }}
            >
              <SelectTrigger
                aria-label="What this message is"
                size="compact"
                variant="ghost"
                className="w-auto min-w-0"
              >
                <SelectValue>{COMPOSER_KIND_LABEL[kind]}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {kinds.map((item) => (
                  <SelectItem key={item} value={item}>
                    <span className="flex max-w-96 flex-col">
                      <span>{COMPOSER_KIND_LABEL[item]}</span>
                      <span className="text-xs text-muted-foreground">{help(item)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          <span className="min-w-0 flex-1" />
          <MobileHelp label="About this message" always>
            <p>
              {effect.moves ? "Moves the work:" : "Changes nothing:"} {effect.label}
            </p>
            <p className="mt-2 text-muted-foreground">{help(kind)}</p>
          </MobileHelp>
          {/* The send button is round, like the chat composer's. */}
          <span className="ml-auto flex shrink-0 [--control-radius:9999px]">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    aria-label={`Send: ${COMPOSER_KIND_LABEL[kind]}`}
                    disabled={!canSend}
                    onClick={() => void send()}
                    data-task-send
                  />
                }
              >
                <SendIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {uploading ? "Files are still on their way." : `Send: ${COMPOSER_KIND_LABEL[kind]}`}
              </TooltipPopup>
            </Tooltip>
          </span>
        </div>
        {/* Said only when sending moves the work; the rest is behind the info icon. */}
        {effect.moves ? (
          <p
            className="hidden items-start gap-1.5 text-2xs text-warning-foreground [@media(min-width:640px)_and_(min-height:600px)]:flex"
            data-task-composer-effect="moves"
          >
            <span className="shrink-0 font-medium">Moves the work:</span>
            <span className="min-w-0">{effect.label}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
