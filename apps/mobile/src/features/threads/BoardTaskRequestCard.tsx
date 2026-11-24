import {
  boardTaskAnswerError,
  boardTaskRequestLabel,
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
import { T, useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function BoardTaskRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
}) {
  const gt = useGT();
  const m = useMessages();
  const {
    environmentId,
    projectedItem: { item, visibility },
  } = props;
  const answer = useAtomCommand(serverEnvironment.answerBoardTask, {
    label: "answer board task request",
    reportFailure: false,
  });
  const canAnswer = useAtomValue(serverEnvironment.answerBoardTask.permissionAtom(environmentId));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  if (item.type !== "board_task_request") return null;
  const { draft, resolution } = item;
  const pending = resolution.status === "pending" && visibility === "local";

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
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-base text-foreground">
        {pending ? <T>File a board task?</T> : boardTaskRequestLabel(item, m)}
      </Text>
      <View className="gap-1">
        <Text className="font-sans text-xs text-foreground-muted">
          <T>Board</T>
        </Text>
        <Text className="font-sans text-sm text-foreground">{draft.board}</Text>
        <Text className="font-sans text-xs text-foreground-muted">
          <T>Title</T>
        </Text>
        <Text className="font-sans text-sm text-foreground">{draft.title}</Text>
      </View>
      <Text className="font-sans text-sm text-foreground">{draft.body}</Text>
      {draft.context === undefined ? null : (
        <View className="gap-1 border-l-2 border-border pl-3">
          <Text className="font-sans text-xs text-foreground-muted">
            <T>Quoted context</T>
          </Text>
          <Text className="font-sans text-sm text-foreground">{draft.context}</Text>
        </View>
      )}
      {resolution.status === "failed" ? (
        <Text className="font-sans text-sm text-danger-foreground">{resolution.message}</Text>
      ) : null}
      {pending && error !== null ? (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {pending ? (
        <>
          <Button
            label={gt("File")}
            tone="primary"
            fullWidth
            disabled={submitting || !canAnswer}
            onPress={() => void submit("file")}
          />
          <Button
            label={gt("Decline")}
            tone="text"
            fullWidth
            disabled={submitting || !canAnswer}
            onPress={() => void submit("decline")}
          />
        </>
      ) : null}
    </View>
  );
}
