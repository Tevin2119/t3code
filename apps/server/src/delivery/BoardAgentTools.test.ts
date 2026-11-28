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

const outcomes = (result: {
  readonly items?: ReadonlyArray<{ readonly id: string; readonly outcome: string }> | undefined;
}) => (result.items ?? []).map((item) => [item.id, item.outcome]);

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

it.effect("boards: protected by deployment or by repository, removed only after a dry run", () => {
  const engine = agentEngine();
  engine.addRepository("illusivetrading-journal");
  engine.addBoard("shipping", { deploymentProjectId: "proj-1" });
  engine.addBoard("journal", { repository: "illusivetrading-journal", deploymentProjectId: null });
  return run(
    engine,
    Effect.gen(function* () {
      const tools = yield* BoardAgentTools;
      const listed = yield* tools.board(scope, { action: "list" });
      assert.deepEqual(
        listed.boards.map((board) => [board.id, board.protected]),
        [
          ["shipping", true],
          ["journal", true],
        ],
      );
      assert.isTrue(listed.repositories?.every((repository) => repository.id !== "qualification"));

      const created = yield* tools.board(scope, {
        action: "create",
        title: "Work",
        repository: "app",
      });
      assert.deepInclude(created.boards[0], { id: "work", protected: false });
      const noTitle = yield* failureOf(tools.board(scope, { action: "create", repository: "app" }));
      assert.equal(noTitle.message, "This action needs `title`.");
      const edited = yield* tools.board(scope, { action: "edit", board: "work", title: "Items" });
      assert.equal(edited.boards[0]?.title, "Items");
      const guarded = yield* failureOf(tools.board(scope, { action: "remove", board: "journal" }));
      assert.match(guarded.message, /protected/);

      const kept = engine.addTask({ set: "work" });
      const preview = yield* tools.board(scope, { action: "remove", board: "work" });
      assert.deepEqual(preview.tasks, [kept.id]);
      assert.isString(preview.dryRunToken);
      assert.match(preview.next ?? "", /only if they agree/);
      assert.isFalse(engine.writes.some((write) => write.path.endsWith("/remove")));
      // A task joined the board since: the confirm is refused and nothing is removed.
      engine.addTask({ set: "work" });
      const changed = yield* failureOf(
        tools.board(scope, {
          action: "remove",
          board: "work",
          confirm: true,
          dryRunToken: preview.dryRunToken!,
        }),
      );
      assert.match(changed.message, /changed since the dry run/);
      const again = yield* tools.board(scope, { action: "remove", board: "work" });
      const reused = yield* failureOf(
        tools.board(scope, { action: "remove", board: "work", confirm: true }),
      );
      assert.match(reused.message, /needs the `dryRunToken`/);
      const removed = yield* tools.board(scope, {
        action: "remove",
        board: "work",
        confirm: true,
        dryRunToken: again.dryRunToken!,
      });
      assert.lengthOf(removed.tasks ?? [], 2);
      assert.isUndefined(removed.dryRunToken);
      assert.isNull(engine.tasks.get(kept.id)?.set);
      assert.isTrue(engine.writes.every((write) => write.body.by === BY));
    }),
  );
});

it.effect("lists by every predicate here, and paging ends at the engine's window", () => {
  const engine = agentEngine();
  engine.addBoard("work");
  engine.addBoard("other");
  const old = engine.addTask({ title: "Old cleanup", origin: "thread:x" });
  const draft = engine.addTask({ state: "draft", lane: "draft", title: "Draft cleanup" });
  // Same origin on another board: the engine's origin search alone would return it too.
  const elsewhere = engine.addTask({ set: "other", origin: "thread:x" });
  const newest = engine.addTask({ title: "Newest" });
  return run(
    engine,
    Effect.gen(function* () {
      const tools = yield* BoardAgentTools;
      const ids = (filter: Record<string, string>, limit?: number) =>
        tools
          .tasks(scope, { action: "list", filter, ...(limit === undefined ? {} : { limit }) })
          .pipe(Effect.map((result) => result.tasks?.map((task) => task.id)));
      assert.deepEqual(yield* ids({}), [newest.id, elsewhere.id, draft.id, old.id]);
      assert.deepEqual(yield* ids({ board: "work", origin: "thread:x" }), [old.id]);
      assert.deepEqual(yield* ids({ lane: "draft" }), [draft.id]);
      assert.deepEqual(yield* ids({ state: "ready", query: "cleanup" }), [old.id]);
      assert.deepEqual(yield* ids({ query: `#${draft.number}` }), [draft.id]);
      assert.deepEqual(yield* ids({ updatedBefore: draft.updated }), [old.id]);
      const page = yield* tools.tasks(scope, { action: "list", limit: 2 });
      assert.deepEqual([page.more, page.truncated], [true, false]);

      for (let index = 0; index < 500; index++) engine.addTask({ set: "other" });
      // Older than the engine's newest 500: unreachable, and the list says so rather than "more".
      const beyond = yield* tools.tasks(scope, {
        action: "list",
        filter: { updatedBefore: newest.updated! },
      });
      assert.deepEqual([beyond.tasks, beyond.more, beyond.truncated], [[], false, true]);
    }),
  );
});

it.effect("one task: edit, submit, move and close in one call; discard after a dry run", () => {
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
      const task = (input: Parameters<typeof tools.task>[1]) => tools.task(scope, input);
      assert.equal((yield* task({ action: "edit", task: draft.id, body: "New" })).body, "New");
      assert.deepInclude(yield* task({ action: "submit", task: draft.id }), { lane: "queue" });
      const late = yield* failureOf(task({ action: "edit", task: draft.id, body: "Late" }));
      assert.match(late.message, /has been submitted/);
      assert.deepInclude(yield* task({ action: "move", task: draft.id, lane: "paused" }), {
        lane: "paused",
      });
      const otherRepo = yield* failureOf(
        task({ action: "move", task: draft.id, board: "api-board" }),
      );
      assert.match(otherRepo.message, /Pass `base`/);
      const relocated = yield* task({
        action: "move",
        task: draft.id,
        board: "api-board",
        base: "main",
      });
      assert.equal(relocated.board, "api-board");

      const liveClose = yield* failureOf(task({ action: "close", task: live.id, reason: "Stale" }));
      assert.match(liveClose.message, /live run/);
      // Close is one call: there is no dry run for it.
      const closed = yield* task({ action: "close", task: live.id, reason: "Stale", force: true });
      assert.isUndefined(closed.dryRunToken);
      assert.deepInclude(closed, { state: "closed", live: false });

      const fresh = engine.addTask({ state: "draft", lane: "draft" });
      const discard = yield* task({ action: "discard", task: fresh.id });
      assert.isTrue(engine.tasks.has(fresh.id));
      // Submitted since the dry run: the confirm finds it changed and leaves it.
      engine.tasks.get(fresh.id)!.state = "ready";
      const changed = yield* failureOf(
        task({
          action: "discard",
          task: fresh.id,
          confirm: true,
          dryRunToken: discard.dryRunToken!,
        }),
      );
      assert.match(changed.message, /changed since the dry run/);
      engine.tasks.get(fresh.id)!.state = "draft";
      const retry = yield* task({ action: "discard", task: fresh.id });
      const gone = yield* task({
        action: "discard",
        task: fresh.id,
        confirm: true,
        dryRunToken: retry.dryRunToken!,
      });
      assert.deepInclude(gone, { id: fresh.id, state: "discarded" });
      assert.isFalse(engine.tasks.has(fresh.id));
    }),
  );
});

it.effect("a bulk close binds its call, its list and each task, and re-checks each one", () => {
  const engine = agentEngine();
  engine.addBoard("work");
  const stale = [engine.addTask(), engine.addTask(), engine.addTask()];
  const live = engine.addTask({ run: { id: "run-2", state: "running", stage: "build" } });
  return run(
    engine,
    Effect.gen(function* () {
      const tools = yield* BoardAgentTools;
      const close = (fields: Record<string, unknown>) =>
        tools.tasks(scope, { action: "close", reason: "Stale", ...fields });
      const byIds = yield* close({ tasks: [stale[0]!.id, "task-missing"] });
      assert.deepEqual(outcomes(byIds), [
        [stale[0]!.id, "would-act"],
        ["task-missing", "not-found"],
      ]);
      assert.isEmpty(engine.writes);

      const filter = { board: "work" };
      const preview = yield* close({ filter });
      assert.deepEqual(outcomes(preview), [
        [live.id, "skipped"],
        [stale[2]!.id, "would-act"],
        [stale[1]!.id, "would-act"],
        [stale[0]!.id, "would-act"],
      ]);
      // Another filter spelling that matches the same: still another call.
      const otherFilter = yield* failureOf(
        close({
          filter: { board: "work", state: "ready" },
          confirm: true,
          dryRunToken: preview.dryRunToken!,
        }),
      );
      assert.match(otherFilter.message, /differs from its dry run/);

      const second = yield* close({ filter });
      engine.addTask();
      const grew = yield* failureOf(
        close({ filter, confirm: true, dryRunToken: second.dryRunToken! }),
      );
      assert.match(grew.message, /changed since the dry run/);
      assert.isEmpty(engine.writes);

      const third = yield* close({ filter: { board: "work", query: "Task" } });
      // One task starts a run after the dry run: it is skipped, the others close.
      engine.tasks.get(stale[1]!.id)!.run = { id: "run-3", state: "running", stage: "build" };
      const done = yield* close({
        filter: { query: "Task", board: "work" },
        confirm: true,
        dryRunToken: third.dryRunToken!,
      });
      const byId = new Map(done.items?.map((item) => [item.id, item]));
      assert.equal(byId.get(stale[1]!.id)?.message, "changed since the dry run");
      assert.equal(byId.get(stale[0]!.id)?.outcome, "done");
      assert.equal(byId.get(live.id)?.outcome, "skipped");
      assert.equal(engine.tasks.get(stale[1]!.id)?.state, "ready");
      assert.equal(engine.tasks.get(stale[0]!.id)?.state, "closed");
      const used = yield* failureOf(
        close({
          filter: { query: "Task", board: "work" },
          confirm: true,
          dryRunToken: third.dryRunToken!,
        }),
      );
      assert.match(used.message, /unknown or expired/);
      assert.isTrue(engine.writes.every((write) => write.body.by === BY));
    }),
  );
});

it.effect(
  "a bulk move that kept the board cannot be confirmed as a move to a board named keep",
  () => {
    const engine = agentEngine();
    engine.addBoard("work");
    engine.addBoard("keep");
    const picked = engine.addTask({ state: "draft", lane: "draft" });
    return run(
      engine,
      Effect.gen(function* () {
        const tools = yield* BoardAgentTools;
        const preview = yield* tools.tasks(scope, {
          action: "move",
          tasks: [picked.id],
          lane: "queue",
        });
        const refused = yield* failureOf(
          tools.tasks(scope, {
            action: "move",
            tasks: [picked.id],
            lane: "queue",
            board: "keep",
            confirm: true,
            dryRunToken: preview.dryRunToken!,
          }),
        );
        assert.match(refused.message, /differs from its dry run/);
        assert.isEmpty(engine.writes);
        assert.equal(engine.tasks.get(picked.id)?.set, "work");
      }),
    );
  },
);

it.effect("a board with more tasks than one read shows is not previewed for removal", () => {
  const engine = agentEngine();
  engine.addBoard("big");
  for (let index = 0; index < 500; index++) engine.addTask({ set: "big" });
  return run(
    engine,
    Effect.gen(function* () {
      const tools = yield* BoardAgentTools;
      const refused = yield* failureOf(tools.board(scope, { action: "remove", board: "big" }));
      assert.match(refused.message, /Close or move some of its tasks first/);
      assert.isEmpty(engine.writes);
    }),
  );
});

it.effect("a bulk move sends the lane each card was seen in", () => {
  const engine = agentEngine();
  engine.addBoard("work");
  const picked = [
    engine.addTask({ state: "draft", lane: "draft" }),
    engine.addTask({ state: "draft", lane: "draft" }),
  ];
  return run(
    engine,
    Effect.gen(function* () {
      const tools = yield* BoardAgentTools;
      const tasks = picked.map((task) => task.id);
      const preview = yield* tools.tasks(scope, { action: "move", tasks, lane: "queue" });
      const done = yield* tools.tasks(scope, {
        action: "move",
        tasks,
        lane: "queue",
        confirm: true,
        dryRunToken: preview.dryRunToken!,
      });
      assert.deepEqual(
        outcomes(done).map(([, outcome]) => outcome),
        ["done", "done"],
      );
      assert.isTrue(
        engine.writes.every((write) => write.path.endsWith("/move") && write.body.seen === "draft"),
      );
    }),
  );
});

it.effect(
  "engine controls use the saved key, refuse without one, and repeat no engine words",
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
        assert.deepEqual(engine.writes.at(-1)?.body, { key: engine.key, action: "restart" });
        const update = yield* tools.engineControl({ action: "update", commit: "c".repeat(40) });
        // The engine's answer echoes the key in its id and an extra field: only fixed formats pass.
        assert.deepEqual(update, {
          ok: true,
          action: "update",
          state: "accepted",
          id: null,
          commit: "c".repeat(40),
          channel: "qa",
        });
        assert.notInclude(JSON.stringify(update), engine.key);

        yield* delivery.setBoardApprovalKey("an old passphrase");
        const wrong = yield* Effect.flip(tools.engineControl({ action: "update" }));
        assert.equal(wrong.detail, DeliveryService.keyedRefusal(403));
        assert.isUndefined(wrong.body);
        assert.notInclude(JSON.stringify(wrong), "an old passphrase");
      }),
    );
  },
);

it.effect("saved-key engine controls share the server's two key checks", () => {
  const engine = agentEngine();
  return run(
    engine,
    Effect.gen(function* () {
      const tools = yield* BoardAgentTools;
      const delivery = yield* DeliveryService.DeliveryService;
      yield* delivery.setBoardApprovalKey(engine.key);
      const receipts = yield* Effect.all(
        Array.from({ length: 4 }, () => tools.engineLifecycle({ action: "restart" })),
        { concurrency: "unbounded" },
      );
      assert.lengthOf(receipts, 4);
      assert.equal(engine.keyChecks.most, 2);
    }),
  );
});
