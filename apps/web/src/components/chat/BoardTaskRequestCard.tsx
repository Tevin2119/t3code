import {
  boardTaskAnswerError,
  boardTaskRequestLabel,
  type BoardTaskRequestItem,
} from "@t3tools/client-runtime/board-task-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  BoardTaskAnswerInput,
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { T, useMessages } from "gt-react";
import { useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function BoardTaskRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: BoardTaskRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const m = useMessages();
  const { item, environmentId, visibility } = props;
  const { draft, resolution } = item;
  const pending = resolution.status === "pending" && visibility === "local";
  const answer = useAtomCommand(serverEnvironment.answerBoardTask, {
    label: "answer board task request",
    reportFailure: false,
  });
  const canAnswer = useAtomValue(serverEnvironment.answerBoardTask.permissionAtom(environmentId));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const submit = async (decision: BoardTaskAnswerInput["answer"]) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({
      environmentId,
      input: { threadId: item.threadId, turnItemId: item.id, answer: decision },
    }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    setError(boardTaskAnswerError(squashAtomCommandFailure(result), m));
  };

  return (
    <section
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <h3 className="text-sm font-medium text-foreground">
        {pending ? <T>File a board task?</T> : boardTaskRequestLabel(item, m)}
      </h3>
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">
          <T>Board</T>
        </dt>
        <dd className="min-w-0 wrap-anywhere">{draft.board}</dd>
        <dt className="text-muted-foreground">
          <T>Title</T>
        </dt>
        <dd className="min-w-0 whitespace-pre-wrap wrap-anywhere">{draft.title}</dd>
      </dl>
      <p className="whitespace-pre-wrap wrap-anywhere text-sm">{draft.body}</p>
      {draft.context === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            <T>Quoted context</T>
          </span>
          <blockquote className="border-l-2 border-border pl-3 text-sm whitespace-pre-wrap wrap-anywhere">
            {draft.context}
          </blockquote>
        </div>
      )}
      {resolution.status === "failed" ? (
        <p className="text-xs text-destructive">{resolution.message}</p>
      ) : null}
      {pending && error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {pending ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost-muted"
            disabled={submitting || !canAnswer}
            onClick={() => void submit("decline")}
          >
            <T>Decline</T>
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={submitting || !canAnswer}
            onClick={() => void submit("file")}
          >
            <T>File</T>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
