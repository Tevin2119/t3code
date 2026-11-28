import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { listBoardThreadRows } from "./boardThreadRows.ts";
import {
  boardTaskOf,
  boardTaskOfMarker,
  boardTaskThreadCommandId,
  boardTaskThreadId,
  createBoardTaskThread,
  isBoardTaskThreadId,
} from "./boardThreadMarker.ts";

// "Discuss in a thread" forks a board task's thread as T3's own side chat. The fork must not
// carry the task's marker, or the board would take it for the task's thread and bind it.

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("No turn runs in this case"),
};
// One database, which the board's own row query reads beside the orchestrator.
const database = SqlitePersistence.layerMemory;
const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "board-task-side-chat" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false, databaseLayer: database },
).pipe(Layer.provideMerge(database));

const TASK = boardTaskOf("work", "task-9")!;
const TASK_THREAD = boardTaskThreadId(TASK);
const SIDE_CHAT = ThreadId.make("task-9-side-chat");

it.effect("a side chat of a task thread carries no marker, is never bound, and leaves it be", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch(
      createBoardTaskThread(TASK, {
        commandId: boardTaskThreadCommandId(TASK),
        threadId: TASK_THREAD,
        projectId: ProjectId.make("board-task-side-chat-project"),
        title: "Fix the sync",
        modelSelection: { instanceId, model: "test-model" },
      }),
    );
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("task-9-discuss"),
      sourceThreadId: TASK_THREAD,
      targetThreadId: SIDE_CHAT,
      sourcePoint: { type: "latest_stable" },
      title: "Side chat",
      sideChat: true,
      createdBy: "user",
      creationSource: "web",
    });

    const fork = (yield* orchestrator.getThreadProjection(SIDE_CHAT)).thread;
    assert.deepStrictEqual(fork.lineage, {
      parentThreadId: TASK_THREAD,
      relationshipToParent: "fork",
      rootThreadId: TASK_THREAD,
      sideChat: true,
    });
    assert.isNull(boardTaskOfMarker(fork.lineage.engineIntake));
    assert.isFalse(isBoardTaskThreadId(fork.id));
    // The board finds its task threads by marker alone: the task's thread, not its side chat.
    const listed = () =>
      listBoardThreadRows({ archived: false }).pipe(
        Effect.map((rows) => rows.map((row) => [row.threadId, row.task.id])),
      );
    assert.deepStrictEqual(yield* listed(), [[TASK_THREAD, TASK.id]]);
    assert.deepStrictEqual(yield* listBoardThreadRows({ archived: true }), []);

    // Archiving or closing the side chat never changes the task's thread.
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("task-9-side-chat-archive"),
      threadId: SIDE_CHAT,
    });
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("task-9-side-chat-close"),
      threadId: SIDE_CHAT,
      onlyIfUnused: true,
    });
    const task = (yield* orchestrator.getThreadProjection(TASK_THREAD)).thread;
    assert.isNull(task.archivedAt);
    assert.isNull(task.deletedAt);
    assert.deepStrictEqual(boardTaskOfMarker(task.lineage.engineIntake), TASK);
    assert.deepStrictEqual(yield* listed(), [[TASK_THREAD, TASK.id]]);
  }).pipe(Effect.provide(layer)),
);
