import {
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { briefMessageId, engineStageNotice, stageMessageId } from "./boardTaskAttempts.ts";
import { boardTaskOf, boardTaskThreadId } from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";
import * as TeamChatReadOnlyReactor from "./TeamChatReadOnlyReactor.ts";

const parentId = ThreadId.make("team-parent");
const childId = ThreadId.make("team-child");

function setup({
  access = undefined as "approval-required" | "full-access" | undefined,
  /** The researcher's own access, over the conversation's. */
  seatAccess = undefined as "read-only" | "full-access" | undefined,
  participant = true,
} = {}) {
  const dispatched: Array<OrchestrationV2Command> = [];
  const engine = {
    dispatch: (command: OrchestrationV2Command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return {};
      }),
    streamDomainEvents: Stream.empty,
  } as unknown as Orchestrator.OrchestratorV2["Service"];
  const projections = {
    getThread: () => Effect.succeed({ id: childId, lineage: { parentThreadId: parentId } }),
    getThreadRecords: () =>
      Effect.succeed({
        subagents: [
          {
            childThreadId: childId,
            ...(participant ? { teamChat: { seat: "researcher" } } : {}),
          },
        ],
      }),
  } as unknown as ProjectionStore.ProjectionStoreV2["Service"];
  const delivery = {
    threadState: () =>
      Effect.succeed({
        binding: null,
        pending: null,
        lineup: {
          participants: seatAccess ? [{ seat: "researcher", access: seatAccess }] : [],
          ...(access ? { access } : {}),
        },
      }),
  } as unknown as DeliveryService.DeliveryService["Service"];
  return {
    dispatched,
    reactor: TeamChatReadOnlyReactor.TeamChatReadOnlyReactor.pipe(
      Effect.provide(TeamChatReadOnlyReactor.layer),
      Effect.provideService(Orchestrator.OrchestratorV2, engine),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
      Effect.provideService(DeliveryService.DeliveryService, delivery),
    ),
  };
}

const request = (kind: string, status = "pending", supportsFeedback = true) =>
  ({
    type: "runtime-request.updated",
    threadId: childId,
    payload: {
      id: "request-1",
      kind,
      status,
      responseCapability: { type: "live", providerSessionId: "session", supportsFeedback },
    },
  }) as unknown as OrchestrationV2DomainEvent;

it.effect("declines what a read-only participant asks to change, and nothing else", () =>
  Effect.gen(function* () {
    const readOnly = setup();
    const reactor = yield* readOnly.reactor;
    yield* reactor.handle(request("command"));
    expect(readOnly.dispatched).toMatchObject([
      {
        type: "runtime-request.respond",
        threadId: childId,
        requestId: "request-1",
        decision: "decline",
        feedback: TeamChatReadOnlyReactor.READ_ONLY_FEEDBACK,
      },
    ]);
    // A question and a request that is already answered are left alone.
    yield* reactor.handle(request("user_input"));
    yield* reactor.handle(request("file-change", "resolved"));
    expect(readOnly.dispatched).toHaveLength(1);

    // A provider that takes no reason with a decline is declined without one.
    yield* reactor.handle(request("file-change", "pending", false));
    expect(readOnly.dispatched[1]).toMatchObject({ decision: "decline" });
    expect(readOnly.dispatched[1]).not.toHaveProperty("feedback");
    // A read is let through without asking anyone.
    yield* reactor.handle(request("file-read"));
    expect(readOnly.dispatched[2]).toMatchObject({ decision: "accept" });

    // A conversation that chose an access answers its own requests.
    for (const chosen of [
      setup({ access: "approval-required" }),
      setup({ access: "full-access" }),
    ]) {
      yield* (yield* chosen.reactor).handle(request("file-change"));
      expect(chosen.dispatched).toEqual([]);
    }

    // A seat's own access comes before the conversation's, in either direction.
    const held = setup({ access: "full-access", seatAccess: "read-only" });
    yield* (yield* held.reactor).handle(request("file-change"));
    expect(held.dispatched).toMatchObject([{ decision: "decline" }]);
    const lifted = setup({ seatAccess: "full-access" });
    yield* (yield* lifted.reactor).handle(request("file-change"));
    expect(lifted.dispatched).toEqual([]);

    // A delegated task that is not a discussion participant is not touched.
    const other = setup({ participant: false });
    yield* (yield* other.reactor).handle(request("command"));
    expect(other.dispatched).toEqual([]);
  }),
);

it.effect("declines the engine's read-only brief and seats, and nothing a person runs", () =>
  Effect.gen(function* () {
    const board = boardTaskThreadId(boardTaskOf("work", "task-7")!);
    const child = ThreadId.make("engine-seat");
    const run = (id: string, userMessageId: string) => ({ id, userMessageId });
    const dispatched: Array<OrchestrationV2Command> = [];
    const runtimeMode = { current: "approval-required" };
    const seat = (access: "read-only" | "full") => ({
      attemptId: "att-qa",
      seat: "qa",
      childThreadId: child,
      modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
      access,
      worktreePath: "/work/qa",
    });
    const stageAccess = { current: "read-only" as "read-only" | "full" };
    const reactor = yield* TeamChatReadOnlyReactor.TeamChatReadOnlyReactor.pipe(
      Effect.provide(TeamChatReadOnlyReactor.layer),
      Effect.provideService(Orchestrator.OrchestratorV2, {
        dispatch: (command: OrchestrationV2Command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return {};
          }),
        streamDomainEvents: Stream.empty,
      } as unknown as Orchestrator.OrchestratorV2["Service"]),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        getThread: (threadId: ThreadId) =>
          Effect.succeed(
            threadId === board
              ? { id: board, lineage: { parentThreadId: null, engineIntake: board } }
              : { id: child, lineage: { parentThreadId: board } },
          ),
        getThreadRecords: () =>
          Effect.succeed({
            thread: { runtimeMode: runtimeMode.current },
            runs: [
              run("brief", briefMessageId("att-plan")),
              run("person", "message:person"),
              run("stage", stageMessageId("att-qa")),
            ],
            subagents: [{ childThreadId: child, runId: "stage" }],
          }),
        getMessagesById: () =>
          Effect.succeed(
            new Map([
              [
                stageMessageId("att-qa"),
                { notification: engineStageNotice("qa", [seat(stageAccess.current)] as never) },
              ],
            ]),
          ),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Effect.provideService(DeliveryService.DeliveryService, {} as never),
    );
    const on = (threadId: ThreadId, runId: string) =>
      ({ ...request("file-change"), threadId, runId }) as unknown as OrchestrationV2DomainEvent;
    yield* reactor.handle(on(board, "brief"));
    expect(dispatched).toMatchObject([{ threadId: board, decision: "decline" }]);
    // A person's own turn in the task thread is theirs to answer.
    yield* reactor.handle(on(board, "person"));
    // A thread back in full access asks nothing to decline.
    runtimeMode.current = "full-access";
    yield* reactor.handle(on(board, "brief"));
    expect(dispatched).toHaveLength(1);
    // An engine stage's read-only seat is declined; a full-access one answers its own requests.
    yield* reactor.handle(on(child, "stage"));
    expect(dispatched[1]).toMatchObject({ threadId: child, decision: "decline" });
    stageAccess.current = "full";
    yield* reactor.handle(on(child, "stage"));
    expect(dispatched).toHaveLength(2);
  }),
);
