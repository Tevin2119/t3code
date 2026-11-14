import type { EnvironmentId, ModelSelection, ThreadId } from "@t3tools/contracts";
import { UsersIcon } from "lucide-react";
import { deliveryEnvironment, trackLineupMutation, useDeliveryEnabled } from "../../state/delivery";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * The single/team switch beside the thread's badge, for a conversation that
 * has started. The server remembers the team a conversation switches away
 * from, so the team comes back with one click on any browser or device.
 */
export function TeamChatToggle(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId;
  /** What the thread runs now; remembered as the lead model of the saved team. */
  readonly leadModelSelection: ModelSelection | null;
  /** Points the thread back at the lead model the team was saved with. */
  readonly onRestoreLead?: ((modelSelection: ModelSelection) => void) | undefined;
  /**
   * The conversation this one was forked from. A 1:1 chat with a participant of a
   * team-bound conversation is a fork with no team of its own: its team is there.
   */
  readonly forkedFromThreadId?: ThreadId | null | undefined;
  /** Opens the conversation this one was forked from. */
  readonly onOpenForkSource?: ((threadId: ThreadId) => void) | undefined;
}) {
  const enabled = useDeliveryEnabled(props.environmentId);
  const state = useEnvironmentQuery(
    enabled && props.environmentId
      ? deliveryEnvironment.threadBinding({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        })
      : null,
  );
  const forkSource = useEnvironmentQuery(
    enabled && props.environmentId && props.forkedFromThreadId
      ? deliveryEnvironment.threadBinding({
          environmentId: props.environmentId,
          input: { threadId: props.forkedFromThreadId },
        })
      : null,
  );
  const setLineup = useAtomCommand(deliveryEnvironment.setThreadLineup, {
    label: "change participants",
    reportFailure: false,
  });
  if (!enabled) return null;
  if (state.data === undefined || state.data === null) return null;
  const lineup = state.data.lineup ?? null;
  const remembered = state.data.rememberedLineup ?? null;
  const teamElsewhere =
    lineup === null &&
    remembered === null &&
    props.forkedFromThreadId &&
    (forkSource.data?.lineup || forkSource.data?.rememberedLineup)
      ? props.forkedFromThreadId
      : null;

  const toggle = async () => {
    if (!props.environmentId) return;
    if (lineup) {
      const result = await trackLineupMutation(
        props.threadId,
        setLineup({
          environmentId: props.environmentId,
          input: {
            threadId: props.threadId,
            orchestration: null,
            ...(props.leadModelSelection
              ? { rememberLeadModelSelection: props.leadModelSelection }
              : {}),
          },
        }),
      );
      if (result._tag === "Failure") {
        toastManager.add({
          type: "warning",
          title: "The team could not be switched off.",
          description: "Try again.",
        });
        return;
      }
      state.refresh();
      return;
    }
    if (teamElsewhere) {
      // Starting the 1:1 put the team conversation in single chat: bring its team back too.
      const left = forkSource.data?.lineup ? null : forkSource.data?.rememberedLineup;
      if (left) {
        const result = await trackLineupMutation(
          teamElsewhere,
          setLineup({
            environmentId: props.environmentId,
            input: { threadId: teamElsewhere, orchestration: left.orchestration },
          }),
        );
        if (result._tag === "Failure") {
          toastManager.add({
            type: "warning",
            title: "The team could not be brought back.",
            description: "Try again.",
          });
          return;
        }
        forkSource.refresh();
      }
      props.onOpenForkSource?.(teamElsewhere);
      return;
    }
    if (!remembered) {
      toastManager.add({
        type: "info",
        title: "This conversation has no team to bring back.",
        description: "A team starts from a new thread: choose Orchestrator in its model picker.",
      });
      return;
    }
    const result = await trackLineupMutation(
      props.threadId,
      setLineup({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, orchestration: remembered.orchestration },
      }),
    );
    if (result._tag === "Failure") {
      toastManager.add({
        type: "warning",
        title: "The team could not be brought back.",
        description: "Try again.",
      });
      return;
    }
    if (remembered.leadModelSelection) props.onRestoreLead?.(remembered.leadModelSelection);
    state.refresh();
  };

  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="min-w-0"
      aria-pressed={lineup !== null}
      aria-label={
        lineup
          ? "Switch to single chat"
          : teamElsewhere
            ? "Go back to the team conversation"
            : "Switch to team chat"
      }
      data-delivery-team-toggle={lineup ? "team" : teamElsewhere ? "fork" : "single"}
      onClick={() => void toggle()}
    >
      <UsersIcon className="size-3.5 shrink-0" />
      {lineup ? "Team chat" : teamElsewhere ? "Back to team" : "Single chat"}
    </Button>
  );
}
