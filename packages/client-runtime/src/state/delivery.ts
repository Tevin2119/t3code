import {
  type DeliveryThreadState,
  type EnvironmentId,
  type ScopedThreadRef,
  type ServerProvider,
  type ServerSettings,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { limitedLeadHandoffThreadId } from "@t3tools/shared/limitedSeat";
import { AsyncResult, Atom } from "effect/reactivity";

import { deliveryBindingAtom } from "../deliveryModelLock.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { scopeThreadRef } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

type LimitedSeatsShell = Pick<EnvironmentThreadShell, "latestRun" | "runtime" | "modelSelection">;

/**
 * Everything a conversation's limited-seat notices are decided from, as one value that changes
 * when any of it does: the lead's latest run and the reset it reported, the thread that run was
 * handed on to, the lineup with its setting, Favorites, and what each provider can run now.
 */
export function limitedSeatsRevision(input: {
  readonly shell: LimitedSeatsShell | null;
  /** The thread the latest run was handed on to, once the client holds it. */
  readonly continued: LimitedSeatsShell | null;
  readonly lineup: DeliveryThreadState["lineup"];
  readonly settings: Pick<ServerSettings, "favorites" | "projectSettingsOverrides"> | null;
  readonly providers: ReadonlyArray<ServerProvider> | null;
}): string {
  const { shell, continued } = input;
  return JSON.stringify([
    shell?.latestRun?.runId ?? null,
    shell?.latestRun?.status ?? null,
    shell?.runtime?.usageLimitResetAt ?? null,
    shell?.modelSelection ?? null,
    continued === null ? null : [continued.modelSelection, continued.latestRun?.runId ?? null],
    input.lineup ?? null,
    input.settings?.favorites ?? null,
    input.settings?.projectSettingsOverrides ?? null,
    (input.providers ?? []).map((provider) => [
      provider.instanceId,
      provider.enabled,
      provider.installed,
      provider.status,
      provider.availability ?? null,
      provider.auth.status,
      provider.auth.email ?? null,
      provider.supportsSessions ?? null,
      // A window's fill moves all day; only reaching or leaving its limit changes a notice.
      (provider.usageLimits?.windows ?? [])
        .filter((window) => (window.usedPercent ?? 0) >= 100)
        .map((window) => [window.id, window.resetsAt ?? null]),
    ]),
  ]);
}

/** Whether a thread's limited run continues in a linked thread, so it must not resume here too. */
export function limitedLeadHandedOn(
  shell: Pick<EnvironmentThreadShell, "latestRun"> | null,
  hasThread: (threadId: ThreadId) => boolean,
): boolean {
  const runId = shell?.latestRun?.runId;
  return runId !== undefined && hasThread(limitedLeadHandoffThreadId(runId));
}

export function createDeliveryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    /** A thread as the client holds it, so its limited-seat notices follow its runs. */
    readonly threadShellAtom?: (ref: ScopedThreadRef) => Atom.Atom<LimitedSeatsShell | null>;
    /** Favorites and provider statuses decide a substitute, so the notices follow them too. */
    readonly settingsAtom?: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<Pick<ServerSettings, "favorites" | "projectSettingsOverrides"> | null>;
    readonly providersAtom?: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<ReadonlyArray<ServerProvider> | null>;
  } = {},
) {
  const { threadShellAtom, settingsAtom, providersAtom } = options;
  const threadBinding = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:delivery:thread-binding",
    tag: WS_METHODS.deliveryThreadBinding,
    staleTimeMs: 1_000,
  });
  const limitedSeatsRevisionAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
      const shell = threadShellAtom
        ? get(threadShellAtom(scopeThreadRef(environmentId, threadId)))
        : null;
      const runId = shell?.latestRun?.runId;
      return limitedSeatsRevision({
        shell,
        continued:
          threadShellAtom && runId !== undefined
            ? get(threadShellAtom(scopeThreadRef(environmentId, limitedLeadHandoffThreadId(runId))))
            : null,
        lineup: AsyncResult.getOrElse(
          get(threadBinding({ environmentId, input: { threadId } })),
          () => null,
        )?.lineup,
        settings: settingsAtom ? get(settingsAtom(environmentId)) : null,
        providers: providersAtom ? get(providersAtom(environmentId)) : null,
      });
    }),
  );
  const limitedLeadHandedOnAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      if (threadShellAtom === undefined) return false;
      const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
      return limitedLeadHandedOn(
        get(threadShellAtom(scopeThreadRef(environmentId, threadId))),
        (continued) => get(threadShellAtom(scopeThreadRef(environmentId, continued))) !== null,
      );
    }),
  );
  const modelBinding = Atom.family((query: ReturnType<typeof threadBinding>) =>
    Atom.family((threadId: string) => deliveryBindingAtom(query, threadId)),
  );
  return {
    /** Engine state changes while a team works, so a reading goes stale quickly. */
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:read",
      tag: WS_METHODS.deliveryRead,
      staleTimeMs: 2_000,
    }),
    /** The archived conversations of board tasks, for the board's own list of them. */
    archivedBoardThreads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:archived-board-threads",
      tag: WS_METHODS.deliveryArchivedBoardThreads,
      staleTimeMs: 2_000,
    }),
    /** The same list read once by hand, for a project removal to count what it keeps. */
    fetchArchivedBoardThreads: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:fetch-archived-board-threads",
      tag: WS_METHODS.deliveryArchivedBoardThreads,
    }),
    /** Whether the server holds the board approval key, and from where. Never the key itself. */
    boardApprovalKey: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:board-approval-key",
      tag: WS_METHODS.deliveryBoardApprovalKey,
      staleTimeMs: 30_000,
    }),
    /** Sets, replaces or clears the saved key. The key is sent once and never read back. */
    setBoardApprovalKey: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:set-board-approval-key",
      tag: WS_METHODS.deliverySetBoardApprovalKey,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    /** A keyed engine control with the saved approval key, which the client never sees. */
    engineControl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:engine-control",
      tag: WS_METHODS.deliveryEngineControl,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    /** A thread's team, or the team choice that is still held. Cheap, and read often. */
    threadBinding,
    linkedBring: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:linked-bring",
      tag: WS_METHODS.deliveryLinkedBring,
    }),
    linkedSend: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:linked-send",
      tag: WS_METHODS.deliveryLinkedSend,
    }),
    linkedHandoffs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:linked-handoffs",
      tag: WS_METHODS.deliveryLinkedHandoffs,
    }),
    linkedHandoffRetry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:linked-handoff-retry",
      tag: WS_METHODS.deliveryLinkedHandoffRetry,
    }),
    linkedSendDestination: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:linked-send-destination",
      tag: WS_METHODS.deliveryLinkedSendDestination,
    }),
    linkedBoards: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:linked-boards",
      tag: WS_METHODS.deliveryLinkedBoards,
      staleTimeMs: 5_000,
    }),
    linkedBoard: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:linked-board",
      tag: WS_METHODS.deliveryLinkedBoard,
      staleTimeMs: 5_000,
    }),
    linkedSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:linked-search",
      tag: WS_METHODS.deliveryLinkedSearch,
      staleTimeMs: 5_000,
    }),
    linkedTask: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:linked-task",
      tag: WS_METHODS.deliveryLinkedTask,
      staleTimeMs: 5_000,
    }),
    linkedMessages: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:linked-messages",
      tag: WS_METHODS.deliveryLinkedMessages,
      staleTimeMs: 5_000,
    }),
    linkedTimeline: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:linked-timeline",
      tag: WS_METHODS.deliveryLinkedTimeline,
      staleTimeMs: 5_000,
    }),
    linkedEvents: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:linked-events",
      tag: WS_METHODS.deliveryLinkedEvents,
      staleTimeMs: 5_000,
    }),
    linkedFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:linked-file",
      tag: WS_METHODS.deliveryLinkedFile,
      staleTimeMs: 5_000,
    }),
    linkedAttached: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:linked-attached",
      tag: WS_METHODS.deliveryLinkedAttached,
      staleTimeMs: 5_000,
    }),
    linkedAttachedFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:linked-attached-file",
      tag: WS_METHODS.deliveryLinkedAttachedFile,
      staleTimeMs: 5_000,
    }),
    linkedComment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:linked-comment",
      tag: WS_METHODS.deliveryLinkedComment,
    }),
    linkedAnswer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:linked-answer",
      tag: WS_METHODS.deliveryLinkedAnswer,
    }),
    linkedControl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:linked-control",
      tag: WS_METHODS.deliveryLinkedControl,
    }),
    linkedSteer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:linked-steer",
      tag: WS_METHODS.deliveryLinkedSteer,
    }),
    linkedTake: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:linked-take",
      tag: WS_METHODS.deliveryLinkedTake,
    }),
    linkedRenew: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:linked-renew",
      tag: WS_METHODS.deliveryLinkedRenew,
    }),
    linkedRelease: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:linked-release",
      tag: WS_METHODS.deliveryLinkedRelease,
    }),
    setBoardLinkedVisibility: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:set-board-linked-visibility",
      tag: WS_METHODS.deliverySetBoardLinkedVisibility,
    }),
    setTaskLinkedHidden: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:set-task-linked-hidden",
      tag: WS_METHODS.deliverySetTaskLinkedHidden,
    }),
    /** Query families include the environment and thread; previous query values never carry over. */
    modelBinding: (target: Parameters<typeof threadBinding>[0]) =>
      modelBinding(threadBinding(target))(target.input.threadId),
    /** One reading asked for by hand, such as a piece of a file. Not kept and not refreshed. */
    fetch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:fetch",
      tag: WS_METHODS.deliveryRead,
    }),
    act: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:act",
      tag: WS_METHODS.deliveryAct,
    }),
    /** Port to app from a release line. A second click while the first runs joins it. */
    filePort: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:file-port",
      tag: WS_METHODS.deliveryFilePort,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.board, input.from, input.to, input.commits]),
      },
    }),
    /** Files a draft from a thread. A second click while the first runs joins it. */
    fileThreadTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:file-thread-task",
      tag: WS_METHODS.deliveryFileThreadTask,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.board]),
      },
    }),
    /** Gives up a team choice whose setup never completed. */
    releaseThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:release-thread",
      tag: WS_METHODS.deliveryReleaseThread,
    }),
    setThreadLineup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:set-thread-lineup",
      tag: WS_METHODS.deliverySetThreadLineup,
      // A conversation's roster changes one at a time, in the order they were made.
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
    }),
    /** Which seats of a conversation are limited now, and what could stand in. */
    limitedSeats: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:delivery:limited-seats",
      tag: WS_METHODS.deliveryLimitedSeats,
      staleTimeMs: 2_000,
      refreshTrigger: ({ environmentId, input }) =>
        limitedSeatsRevisionAtom(JSON.stringify([environmentId, input.threadId])),
    }),
    /** Whether a thread's limited run continues in a linked thread; it then offers no resume. */
    limitedLeadHandedOn: (ref: ScopedThreadRef) =>
      limitedLeadHandedOnAtom(JSON.stringify([ref.environmentId, ref.threadId])),
    /** One click of a limited-seat notice. A second click while the first runs joins it. */
    swapLimitedSeat: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:swap-limited-seat",
      tag: WS_METHODS.deliverySwapLimitedSeat,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.seat]),
      },
    }),
    bindThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delivery:bind-thread",
      tag: WS_METHODS.deliveryBindThread,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
    }),
  };
}
