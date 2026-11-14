import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const runSelection = { instanceId, model: "test-model" };

const teamQueueHarness = Effect.fn("teamQueueHarness")(function* (name: string) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steered: string[] = [];
  const capabilities = CodexProviderCapabilitiesV2;
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const turnUpdated = (
          turn: ProviderAdapter.ProviderAdapterV2TurnInput,
          status: "running" | "interrupted",
        ) =>
          Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
              providerThreadId: turn.providerThread.id,
              nodeId: turn.rootNodeId,
              runAttemptId: turn.attemptId,
              nativeTurnRef: {
                driver,
                nativeId: `native:${turn.attemptId}`,
                strength: "strong",
              },
              ordinal: turn.providerTurnOrdinal,
              status,
              startedAt: now,
              completedAt: status === "running" ? null : now,
            },
          });
        const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            started.push(turn);
            yield* turnUpdated(turn, "running");
          });
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: runSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn,
          compactThread: startTurn,
          steerTurn: (turn) =>
            Effect.sync(() => {
              steered.push(turn.message.text);
            }),
          interruptTurn: ({ providerTurnId }) =>
            Effect.forEach(
              started.filter(
                (turn) => ProviderTurnId.make(`provider-turn:${turn.attemptId}`) === providerTurnId,
              ),
              (turn) =>
                turnUpdated(turn, "interrupted").pipe(
                  Effect.andThen(
                    Queue.offer(events, {
                      type: "turn.terminal",
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId,
                      runOrdinal: turn.runOrdinal,
                      status: "interrupted",
                      failure: null,
                      threadDisposition: "reusable",
                    }),
                  ),
                ),
              { discard: true },
            ),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(adapter),
    { runEffectWorker: false },
  );
  const startFirstTurn = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Team discussion",
      modelSelection: runSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "first",
      attachments: [],
      modelSelection: runSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    // The test advances the seat phase before starting the lead.
    return { threadId, running };
  });
  return { events, started, steered, layer, startFirstTurn };
});

it.effect.each(["contribution", "critique"] as const)(
  "preserves sends during %s, refuses promotion, and answers queued messages in order",
  (stage) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer, startFirstTurn, started, steered, events } = yield* teamQueueHarness(
          `team-${stage}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sink = yield* EventSink.EventSinkV2;
          const { threadId, running } = yield* startFirstTurn;
          const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
          const now = yield* DateTime.now;
          // Persist the phase boundary produced by NativeTeamChat before the lead starts.
          const seat = {
            id: NodeId.make("seat"),
            threadId,
            runId: first.id,
            parentNodeId: first.rootNodeId!,
            origin: "app_owned" as const,
            createdBy: "agent" as const,
            driver,
            providerInstanceId: instanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Assess the question",
            title: "Researcher",
            model: runSelection.model,
            status: "running" as const,
            result: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            teamChat: { sourceRunId: first.id, stage, seat: "researcher" },
          };
          yield* sink.write({
            events: [
              {
                id: EventId.make("seat-start"),
                type: "subagent.updated",
                threadId,
                occurredAt: now,
                payload: seat,
              },
            ],
          });
          const send = (text: string) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`send:${text}`),
              threadId,
              messageId: MessageId.make(`message:${text}`),
              text,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              deliveryIntent: "auto",
              createdBy: "user",
              creationSource: "web",
            });
          yield* send("second");
          yield* send("third");
          const queuedBefore = (yield* orchestrator.getThreadProjection(threadId)).runs.filter(
            (run) => run.status === "queued",
          );
          assert.deepEqual(
            queuedBefore.map((run) => run.userMessageId),
            ["message:second", "message:third"],
          );
          const refusal = yield* orchestrator
            .dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make("promote"),
              threadId,
              queuedRunId: queuedBefore[0]!.id,
              targetRunId: first.id,
            })
            .pipe(Effect.flip);
          if (refusal._tag !== "OrchestratorDispatchError") assert.fail(refusal.message);
          assert.notInclude(String(refusal.cause), first.id);
          assert.include(String(refusal.cause), "Wait");
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            after.runs.filter((run) => run.status === "queued"),
            queuedBefore,
          );
          assert.equal(
            after.messages.find((message) => message.id === "message:second")?.text,
            "second",
          );
          yield* sink.write({
            events: [
              {
                id: EventId.make("seat-finish"),
                type: "subagent.updated",
                threadId,
                occurredAt: now,
                payload: { ...seat, status: "completed", result: "Seat finding", completedAt: now },
              },
            ],
          });

          yield* worker.drain();
          yield* Fiber.join(running);
          yield* send("lead instruction");
          yield* worker.drain();
          assert.deepEqual(steered, ["lead instruction"]);
          const steeredProjection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            steeredProjection.messages.find((message) => message.id === "message:lead instruction")
              ?.runId,
            first.id,
          );
          assert.equal(steeredProjection.subagents[0]?.result, "Seat finding");

          const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          for (let index = 0; index < 3; index++) {
            const input = started[index]!;
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const turn = projection.providerTurns.find(
              (turn) => turn.runAttemptId === input.attemptId,
            )!;
            const settled = yield* watch(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === input.runId &&
                event.payload.status === "waiting",
            );
            const finished = yield* watch(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === input.runId &&
                event.payload.status === "completed",
            );
            const nextStarting =
              index < 2
                ? yield* watch(
                    (event) =>
                      event.type === "run.updated" &&
                      event.payload.status === "starting" &&
                      event.payload.id !== input.runId,
                  )
                : null;
            const next =
              index < 2
                ? yield* watch(
                    (event) =>
                      event.type === "provider-turn.updated" &&
                      event.payload.status === "running" &&
                      event.payload.runAttemptId !== input.attemptId,
                  )
                : null;
            yield* Queue.offer(events, {
              type: "turn_item.updated",
              driver,
              turnItem: {
                id: TurnItemId.make(`answer:${index}`),
                threadId,
                runId: input.runId,
                nodeId: input.rootNodeId,
                providerTurnId: turn.id,
                ordinal: 10 + index,
                type: "assistant_message",
                status: "completed",
                text: `Answer ${index + 1}`,
                providerThreadId: turn.providerThreadId,
                nativeItemRef: null,
                parentItemId: null,
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                messageId: MessageId.make(`answer:${index}`),
                streaming: false,
              },
            });
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...turn, status: "completed", completedAt: now },
            });
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              runOrdinal: input.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });

            yield* Fiber.join(settled);
            yield* worker.drain();
            yield* Fiber.join(finished);
            if (next && nextStarting) {
              yield* Fiber.join(nextStarting);
              yield* worker.drain();
              yield* Fiber.join(next);
            }
          }
          assert.deepEqual(
            started.map((input) => input.message.text),
            ["first", "second", "third"],
          );
          const final = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            final.runs.filter((run) => run.status === "completed").map((run) => run.userMessageId),
            ["message:first", "message:second", "message:third"],
          );
          assert.deepEqual(
            final.turnItems
              .filter((item) => item.type === "assistant_message")
              .map((item) => item.text),
            ["Answer 1", "Answer 2", "Answer 3"],
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each(["starting", "running"] as const)("delivers a send after Stop during %s", (status) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { layer, startFirstTurn, started, steered } = yield* teamQueueHarness(
        `team-stop-${status}`,
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const { threadId, running } = yield* startFirstTurn;
        if (status === "running") {
          yield* worker.drain();
          yield* Fiber.join(running);
        }
        const nextStarting = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              (event.type === "run.updated" || event.type === "run.created") &&
              event.payload.status === "starting" &&
              event.payload.userMessageId === "after-stop",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop"),
          threadId,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("after-stop"),
          threadId,
          messageId: MessageId.make("after-stop"),
          text: "after stop",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "auto",
          createdBy: "user",
          creationSource: "web",
        });
        const sentRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === "after-stop",
        )!;
        const delivered = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.status === "running" &&
              event.payload.runAttemptId === sentRun.activeAttemptId,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* worker.drain();
        if (sentRun.status === "queued") yield* Fiber.join(nextStarting);
        yield* worker.drain();
        yield* Fiber.join(delivered);
        assert.include(started.at(-1)?.message.text ?? "", "after stop");
        assert.deepEqual(steered, []);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, "interrupted");
        assert.equal(projection.runs.at(-1)?.status, "running");
      }).pipe(Effect.provide(layer));
    }),
  ),
);
