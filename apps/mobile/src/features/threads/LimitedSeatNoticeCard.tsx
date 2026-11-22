import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  type LimitedSeatNoticeView,
  limitedSeatNoticeViews,
} from "@t3tools/client-runtime/limited-seat-notices";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { limitedLeadHandoffThreadId } from "@t3tools/shared/limitedSeat";
import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { m } from "../../i18n/messages";
import { deliveryEnvironment } from "../../state/delivery";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * A team conversation's limited lead or seats, following the thread's own setting: the free
 * favorite to swap to in one press, the wait when none is free, and where a lead was handed on.
 * The setting itself is chosen on the desktop or the web.
 */
export function LimitedSeatNoticeCard(props: {
  readonly thread: EnvironmentThreadShell;
  readonly environmentId: EnvironmentId;
  readonly canOperateThread: boolean;
}) {
  const { thread, environmentId } = props;
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const query = useEnvironmentQuery(
    deliveryEnvironment.limitedSeats({ environmentId, input: { threadId: thread.id } }),
  );
  const { refresh } = query;
  const views = limitedSeatNoticeViews(
    query.data,
    {
      modelName: (model) => model.model,
      formatReset: (resetAt) =>
        gt("Resets {date}.", {
          date: new Date(resetAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }),
        }),
    },
    messages,
  );
  const openThread = (threadId: ThreadId) =>
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: String(environmentId),
        threadId: String(threadId),
      }),
    );
  return views.map((view) => (
    <LimitedSeatNotice
      key={view.id}
      view={view}
      environmentId={environmentId}
      threadId={thread.id}
      canOperateThread={props.canOperateThread}
      onSwapped={(next) => {
        refresh();
        if (next !== null) openThread(next);
      }}
      onOpenThread={openThread}
    />
  ));
}

function LimitedSeatNotice(props: {
  readonly view: LimitedSeatNoticeView;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly canOperateThread: boolean;
  readonly onSwapped: (continuedIn: ThreadId | null) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const gt = useGT();
  const { view } = props;
  const swap = useAtomCommand(deliveryEnvironment.swapLimitedSeat);
  const [swapping, setSwapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { action } = view;
  const { continuedIn } = view.notice;

  async function run() {
    if (action?.type !== "swap") return;
    setSwapping(true);
    setError(null);
    const result = await swap({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        seat: view.notice.seat,
        modelSelection: action.substitute,
      },
    });
    setSwapping(false);
    if (AsyncResult.isFailure(result)) {
      setError(
        errorDisplayMessage(squashAtomCommandFailure(result), m) ??
          gt("Could not swap the model. Try again."),
      );
      return;
    }
    props.onSwapped(result.value.continuedIn);
  }

  return (
    <View
      accessibilityRole={view.notice.state === "swapped" ? undefined : "alert"}
      className="mx-3 mb-2 gap-1 rounded-xl border border-warning-foreground/25 bg-screen p-3"
    >
      <Text className="text-sm font-t3-medium text-foreground">{view.title}</Text>
      <Text className="text-sm text-foreground-muted">{view.description}</Text>
      {action?.type === "swap" && props.canOperateThread ? (
        <NoticeAction label={action.label} disabled={swapping} onPress={() => void run()} />
      ) : action?.type === "open" && continuedIn !== undefined ? (
        <NoticeAction
          label={action.label}
          disabled={false}
          onPress={() => props.onOpenThread(continuedIn)}
        />
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Above the composer of a thread whose limited run continues in a linked thread. The server
 * refuses every message to it, so the composer sends nothing and this card leads to the thread
 * that carries the work on.
 */
export function HandedOnThreadCard(props: {
  readonly thread: EnvironmentThreadShell;
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const runId = props.thread.latestRun?.runId;
  const handedOn = useAtomValue(
    deliveryEnvironment.limitedLeadHandedOn(scopeThreadRef(props.environmentId, props.thread.id)),
  );
  if (!handedOn || runId === undefined) return null;
  return (
    <View className="mx-3 mb-2 gap-1 rounded-xl border border-border bg-screen p-3">
      <Text className="text-sm font-t3-medium text-foreground">
        {gt("This conversation continues in a linked thread")}
      </Text>
      <NoticeAction
        label={gt("Open thread")}
        disabled={false}
        onPress={() =>
          navigation.dispatch(
            StackActions.push("Thread", {
              environmentId: String(props.environmentId),
              threadId: String(limitedLeadHandoffThreadId(runId)),
            }),
          )
        }
      />
    </View>
  );
}

function NoticeAction(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    // The margins cancel the 44pt touch height so the action sits 8pt under the text.
    <View className="-mb-3 -mt-2 flex-row">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: props.disabled }}
        disabled={props.disabled}
        hitSlop={{ left: 8, right: 8 }}
        onPress={props.onPress}
        className="min-h-11 justify-center active:opacity-70"
      >
        <Text
          className={
            props.disabled
              ? "text-sm font-t3-medium text-foreground-muted"
              : "text-sm font-t3-medium text-primary"
          }
        >
          {props.label}
        </Text>
      </Pressable>
    </View>
  );
}
