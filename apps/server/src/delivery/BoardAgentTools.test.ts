import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BoardAgentTools, actorOf, layer } from "./BoardAgentTools.ts";
import { agentEngine, agentEngineHttp, type AgentEngine } from "./boardAgentEngine.testkit.ts";
import * as DeliveryService from "./DeliveryService.ts";

const THREAD = ThreadId.make("thread-agent-1");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("env-here"),
  requestNamespace: "session",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  thread: {
    threadId: THREAD,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
};
const BY = `T3 thread ${THREAD}`;

const services = (engine: AgentEngine) =>
  layer.pipe(
    Layer.provideMerge(Layer.fresh(DeliveryService.layer(deriveProviderInstanceConfigMap))),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
    Layer.provideMerge(ServerSecretStore.layer.pipe(Layer.provide(SecureRandom.layerWebCrypto))),
    Layer.provideMerge(Layer.succeed(HostProcess.Environment, {})),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "board-agent-tools-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      ServerSettings.layerTest({ delivery: { enabled: true, engineUrl: "http://127.0.0.1:4320" } }),
    ),
    Layer.provideMerge(agentEngineHttp(engine)),
  );

const run = <A, E>(
  engine: AgentEngine,
  effect: Effect.Effect<A, E, BoardAgentTools | DeliveryService.DeliveryService>,
) => effect.pipe(Effect.provide(services(engine)), Effect.scoped);

const failureOf = <A, E extends { readonly message: string; readonly code?: string }>(
  effect: Effect.Effect<A, E>,
) =>
  Effect.flip(effect).pipe(Effect.map((error) => ({ code: error.code, message: error.message })));

it("names the calling thread, a linked sender, or the client, never like a machine", () => {
  assert.equal(actorOf(scope), BY);
  const linked: McpInvocationScope = {
    ...scope,
    thread: undefined,
    client: {
      sessionId: "s",
      label: "Peer",
      access: "full-access",
      linked: true,
      senderThread: {
        environmentId: EnvironmentId.make("env-there"),
        threadId: ThreadId.make("t-9"),
        title: "T",
      },
    },
  };
  assert.equal(actorOf(linked), "T3 thread t-9 (linked)");
  assert.equal(
    actorOf({ ...linked, client: { ...linked.client!, senderThread: undefined } }),
    "T3 client Peer",
  );
});

it.effect(
  "creates, edits, and removes a board, keeping its tasks and guarding deployment links",
  () => {
    const engine = agentEngine();
    engine.addBoard("shipping", { deploymentProjectId: "proj-1" });
    return run(
      engine,
      Effect.gen(function* () {
        const tools = yield* BoardAgentTools;
        const listed = yield* tools.listBoards;
        assert.deepEqual(listed.repositories, [{ id: "app", title: "App" }]);
        assert.isTrue(listed.boards.find((board) => board.id === "shipping")?.deploymentLinked);

        const created = yield* tools.createBoard(scope, { title: "Work", repository: "app" });
        assert.deepInclude(created, { id: "work", repository: "app", deploymentLinked: false });
        const missing = yield* failureOf(
          tools.createBoard(scope, { title: "X", repository: "nope" }),
        );
        assert.deepEqual(missing, { code: "invalid_request", message: "no repository nope" });

        const edited = yield* tools.editBoard(scope, { board: "work", title: "Work items" });
        assert.equal(edited.title, "Work items");

        const kept = engine.addTask({ set: "work" });
        const removed = yield* tools.removeBoard(scope, { board: "work" });
        assert.deepEqual(removed.tasks, [kept.id]);
        assert.isNull(engine.tasks.get(kept.id)?.set);

        const guarded = yield* failureOf(tools.removeBoard(scope, { board: "shipping" }));
        assert.equal(guarded.code, "invalid_request");
        assert.match(guarded.message, /deployment project/);
        yield* tools.removeBoard(scope, { board: "shipping", force: true });
        assert.deepEqual((yield* tools.listBoards).boards, []);
        assert.isTrue(engine.writes.every((write) => write.body.by === BY));
      }),
    );
  },
);

it.effect("lists tasks by board, lane, state, words and age, newest first", () => {
  const engine = agentEngine();
  engine.addBoard("work");
  engine.addBoard("other");
  const old = engine.addTask({ title: "Old cleanup" });
  const draft = engine.addTask({ state: "draft", lane: "draft", title: "Draft cleanup" });
  const elsewhere = engine.addTask({ set: "other" });
  const newest = engine.addTask({ title: "Newest" });
  return run(
    engine,
    Effect.gen(function* () {
      const tools = yield* BoardAgentTools;
      const ids = (result: { tasks: ReadonlyArray<{ id: string }> }) =>
        result.tasks.map((task) => task.id);
      assert.deepEqual(ids(yield* tools.listTasks({})), [
        newest.id,
        elsewhere.id,
        draft.id,
        old.id,
      ]);
      assert.deepEqual(ids(yield* tools.listTasks({ board: "work" })), [
        newest.id,
        draft.id,
        old.id,
      ]);
      assert.deepEqual(ids(yield* tools.listTasks({ lane: "draft" })), [draft.id]);
      assert.deepEqual(ids(yield* tools.listTasks({ state: "ready", query: "cleanup" })), [old.id]);
      assert.deepEqual(ids(yield* tools.listTasks({ updatedBefore: draft.updated })), [old.id]);
      const page = yield* tools.listTasks({ limit: 2 });
      assert.deepEqual([ids(page), page.more], [[newest.id, elsewhere.id], true]);
    }),
  );
});

it.effect("edits, submits, moves, closes and discards one task as the engine allows", () => {
  const engine = agentEngine();
  engine.addBoard("work");
  engine.addRepository("api");
  engine.addBoard("api-board", { repository: "api" });
  const draft = engine.addTask({ state: "draft", lane: "draft" });
  const live = engine.addTask({ run: { id: "run-1", state: "running", stage: "build" } });
  return run(
    engine,
    Effect.gen(function* () {
      const tools = yield* BoardAgentTools;
      const edited = yield* tools.editTask(scope, { task: draft.id, body: "New text" });
      assert.equal(edited.body, "New text");
      const submitted = yield* tools.submitTask(scope, { task: draft.id });
      assert.deepInclude(submitted, { state: "ready", lane: "queue" });
      const late = yield* failureOf(tools.editTask(scope, { task: draft.id, body: "Too late" }));
      assert.match(late.message, /has been submitted/);

      const paused = yield* tools.moveTask(scope, { task: draft.id, lane: "paused" });
      assert.deepInclude(paused, { lane: "paused", held: true });
      const refusedLane = yield* failureOf(
        tools.moveTask(scope, { task: draft.id, lane: "approved" }),
      );
      assert.equal(refusedLane.code, "invalid_request");

      const otherRepo = yield* failureOf(
        tools.moveTask(scope, { task: draft.id, board: "api-board" }),
      );
      assert.match(otherRepo.message, /Pass `base`/);
      const relocated = yield* tools.moveTask(scope, {
        task: draft.id,
        board: "api-board",
        base: "main",
      });
      assert.equal(relocated.board, "api-board");
      assert.isTrue(engine.writes.some((write) => write.path.endsWith("/relocate")));

      assert.isTrue((yield* tools.getTask({ task: live.id })).live);
      const liveClose = yield* failureOf(
        tools.closeTask(scope, { task: live.id, reason: "Stale" }),
      );
      assert.match(liveClose.message, /live run/);
      const closed = yield* tools.closeTask(scope, { task: live.id, reason: "Stale", force: true });
      assert.deepInclude(closed, { state: "closed", live: false });
      const twice = yield* failureOf(tools.closeTask(scope, { task: live.id, reason: "Again" }));
      assert.match(twice.message, /closed already/);

      const submittedDiscard = yield* failureOf(tools.discardTask(scope, { task: draft.id }));
      assert.match(submittedDiscard.message, /Only a draft/);
      const fresh = engine.addTask({ state: "draft", lane: "draft" });
      assert.deepEqual(yield* tools.discardTask(scope, { task: fresh.id }), {
        discarded: fresh.id,
      });
      assert.isFalse(engine.tasks.has(fresh.id));
      const gone = yield* failureOf(tools.getTask({ task: fresh.id }));
      assert.equal(gone.message, `no task ${fresh.id}`);
    }),
  );
});

it.effect("a bulk close previews, then acts only on the same list with its token", () => {
  const engine = agentEngine();
  engine.addBoard("work");
  const stale = [engine.addTask(), engine.addTask()];
  const live = engine.addTask({ run: { id: "run-2", state: "running", stage: "build" } });
  const draft = engine.addTask({ state: "draft", lane: "draft" });
  return run(
    engine,
    Effect.gen(function* () {
      const tools = yield* BoardAgentTools;
      const filter = { board: "work" };
      const preview = yield* tools.closeTasks(scope, { filter, reason: "Stale" });
      assert.isTrue(preview.dryRun);
      assert.deepEqual(
        preview.items.map((item) => [item.id, item.outcome]),
        [
          [draft.id, "skipped"],
          [live.id, "skipped"],
          [stale[1]!.id, "would-act"],
          [stale[0]!.id, "would-act"],
        ],
      );
      assert.isEmpty(engine.writes);

      const unconfirmed = yield* failureOf(
        tools.closeTasks(scope, { filter, reason: "Stale", confirm: true }),
      );
      assert.match(unconfirmed.message, /dry run/);
      const otherReason = yield* failureOf(
        tools.closeTasks(scope, {
          filter,
          reason: "Other",
          confirm: true,
          dryRunToken: preview.dryRunToken!,
        }),
      );
      assert.match(otherReason.message, /changed since the dry run/);

      engine.touch(stale[0]!.id);
      const changed = yield* failureOf(
        tools.closeTasks(scope, {
          filter,
          reason: "Stale",
          confirm: true,
          dryRunToken: preview.dryRunToken!,
        }),
      );
      assert.match(changed.message, /changed since the dry run/);
      assert.isEmpty(engine.writes);

      const again = yield* tools.closeTasks(scope, { filter, reason: "Stale" });
      const done = yield* tools.closeTasks(scope, {
        filter,
        reason: "Stale",
        confirm: true,
        dryRunToken: again.dryRunToken!,
      });
      assert.isFalse(done.dryRun);
      assert.deepEqual(
        done.items
          .filter((item) => item.outcome === "done")
          .map((item) => item.id)
          .sort(),
        stale.map((task) => task.id).sort(),
      );
      assert.equal(engine.tasks.get(live.id)?.state, "ready");
      assert.isTrue(stale.every((task) => engine.tasks.get(task.id)?.state === "closed"));
      assert.isTrue(
        engine.writes.every((write) => write.body.by === BY && write.body.reason === "Stale"),
      );
    }),
  );
});

it.effect("a bulk move by ids previews and moves each task to the board", () => {
  const engine = agentEngine();
  engine.addBoard("work");
  engine.addBoard("later");
  const picked = [engine.addTask(), engine.addTask()];
  return run(
    engine,
    Effect.gen(function* () {
      const tools = yield* BoardAgentTools;
      const tasks = picked.map((task) => task.id);
      const preview = yield* tools.moveTasks(scope, { tasks, board: "later" });
      assert.deepEqual(
        preview.items.map((item) => item.outcome),
        ["would-act", "would-act"],
      );
      const done = yield* tools.moveTasks(scope, {
        tasks,
        board: "later",
        confirm: true,
        dryRunToken: preview.dryRunToken!,
      });
      assert.deepEqual(
        done.items.map((item) => item.outcome),
        ["done", "done"],
      );
      assert.isTrue(picked.every((task) => engine.tasks.get(task.id)?.set === "later"));
    }),
  );
});

it.effect(
  "engine stop and restart use the saved approval key, never return it, and need one",
  () => {
    const engine = agentEngine();
    return run(
      engine,
      Effect.gen(function* () {
        const tools = yield* BoardAgentTools;
        const delivery = yield* DeliveryService.DeliveryService;
        const unset = yield* Effect.flip(tools.engineLifecycle({ action: "restart" }));
        assert.deepInclude(unset, {
          reason: "refused",
          detail: DeliveryService.NO_BOARD_APPROVAL_KEY,
        });
        assert.isEmpty(engine.writes);

        yield* delivery.setBoardApprovalKey(engine.key);
        const receipt = yield* tools.engineLifecycle({ action: "restart" });
        assert.deepEqual(receipt, {
          accepted: true,
          id: "5f0c2b8e-0d7e-4f61-9d1e-2a4b6c8d0e1f",
          action: "restart",
        });
        assert.notInclude(JSON.stringify(receipt), engine.key);
        assert.deepEqual(engine.writes.at(-1), {
          path: "/api/engine/lifecycle",
          body: { key: engine.key, action: "restart" },
        });

        yield* delivery.setBoardApprovalKey("an old passphrase");
        const wrong = yield* Effect.flip(tools.engineLifecycle({ action: "stop" }));
        assert.deepInclude(wrong, {
          reason: "refused",
          detail: "the approval key is wrong or missing",
        });
        assert.notInclude(JSON.stringify(wrong), "an old passphrase");
      }),
    );
  },
);
