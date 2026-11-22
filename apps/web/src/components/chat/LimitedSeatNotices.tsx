import {
  AuthOrchestrationOperateScope,
  type DeliveryLimitedSeatNotice,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { msg } from "gt-react";
import { ArrowLeftRightIcon, GaugeIcon } from "lucide-react";
import { useState } from "react";

import { m, type MessageResolver } from "~/i18n/messages";
import { deliveryEnvironment } from "../../state/delivery";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { limitedSeatNoticeViews } from "@t3tools/client-runtime/limited-seat-notices";

/**
 * The notices for a team conversation whose lead or seats have reached a usage limit: the free
 * favorite to swap to in one click, the wait when none is free, and where a lead was handed on.
 */
export function useLimitedSeatBannerItems(
  input: {
    readonly environmentId: EnvironmentId;
    /** Null where the conversation has no participants, so nothing is asked of the server. */
    readonly threadId: ThreadId | null;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly timestampFormat: TimestampFormat;
    readonly onOpenThread: (threadId: ThreadId) => void;
  },
  resolve: MessageResolver = m,
): ReadonlyArray<ComposerBannerStackItem> {
  const { environmentId, threadId, providers } = input;
  const query = useEnvironmentQuery(
    threadId === null
      ? null
      : deliveryEnvironment.limitedSeats({ environmentId, input: { threadId } }),
  );
  const { refresh } = query;
  if (threadId === null) return [];
  return limitedSeatNoticeViews(
    query.data,
    {
      modelName: (model) =>
        providers
          .find((provider) => provider.instanceId === model.instanceId)
          ?.models.find((candidate) => candidate.slug === model.model)?.name ?? model.model,
      formatReset: (resetAt) => {
        const time = formatUpcomingTimestamp(
          resetAt,
          input.timestampFormat,
          undefined,
          undefined,
          resolve,
        );
        return time ? resolve(msg("Resets {time}", { time })) : null;
      },
    },
    resolve,
  ).map((view) => {
    const { continuedIn } = view.notice;
    return {
      id: view.id,
      variant: view.notice.state === "swapped" ? "default" : "warning",
      group: "environment",
      icon: <GaugeIcon />,
      title: view.title,
      description: view.description,
      actions:
        view.action?.type === "swap" ? (
          <LimitedSeatSwapButton
            environmentId={environmentId}
            threadId={threadId}
            notice={view.notice}
            substitute={view.action.substitute}
            label={view.action.label}
            onSwapped={(next) => {
              refresh();
              if (next !== null) input.onOpenThread(next);
            }}
          />
        ) : view.action?.type === "open" && continuedIn !== undefined ? (
          <Button size="xs" variant="outline" onClick={() => input.onOpenThread(continuedIn)}>
            {view.action.label}
          </Button>
        ) : null,
    } satisfies ComposerBannerStackItem;
  });
}

/**
 * Swaps a limited seat, or hands a limited lead on, in one click. Built like the provider Fix
 * button: disabled while it works and hidden where threads cannot be run. The command is safe
 * to repeat, so a second click makes no second thread.
 */
function LimitedSeatSwapButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly notice: DeliveryLimitedSeatNotice;
  readonly substitute: ModelSelection;
  readonly label: string;
  /** Called with the thread a lead continues in, or null for a seat. */
  readonly onSwapped: (continuedIn: ThreadId | null) => void;
}) {
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const swap = useAtomCommand(deliveryEnvironment.swapLimitedSeat, {
    label: "swap a limited seat",
    reportFailure: false,
  });
  const [swapping, setSwapping] = useState(false);
  if (!canOperate) return null;

  const run = async () => {
    setSwapping(true);
    const result = await swap({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        seat: props.notice.seat,
        modelSelection: props.substitute,
      },
    });
    setSwapping(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("Could not swap the model")),
        description:
          thrownErrorMessage(squashAtomCommandFailure(result), m) ??
          m(msg("Try again from the notice.")),
      });
      return;
    }
    if (result.value.continuedIn === null) {
      toastManager.add({
        type: "success",
        title: m(msg("Swapped")),
        description: m(msg("It applies from your next message.")),
      });
    }
    props.onSwapped(result.value.continuedIn);
  };

  return (
    <Button disabled={swapping} onClick={() => void run()} size="xs" variant="outline">
      <ArrowLeftRightIcon />
      {props.label}
    </Button>
  );
}
