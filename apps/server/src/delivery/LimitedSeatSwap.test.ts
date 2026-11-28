import {
  DEFAULT_SERVER_SETTINGS,
  DeliveryError,
  type DeliveryOrchestrationConfig,
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import type { LimitedSeatFacts } from "@t3tools/shared/limitedSeat";
import { createModelSelection } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { limitRecoveryCommand } from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { boardTaskOf, boardTaskOfMarker, boardTaskThreadMarker } from "./boardThreadMarker.ts";
import * as BoardThreadRows from "./boardThreadRows.ts";
import * as DeliveryService from "./DeliveryService.ts";
import * as LimitedSeats from "./LimitedSeats.ts";
import * as LimitedSeatSwap from "./LimitedSeatSwap.ts";

const threadId = ThreadId.make("lead-thread");
const runId = RunId.make("lead-run");
const target = LimitedSeatSwap.leadHandoffThreadId(runId);
const NOW = "2026-11-22T12:00:00.000Z";
const RESET = "2026-11-22T17:00:00.000Z";
const ENVIRONMENT = EnvironmentId.make("471fea73-5365-4bbb-96eb-8e35be50eaec");
const BOARD_TASK = boardTaskOf("work", "task-7")!;
const OLD_LINK = { environmentId: ENVIRONMENT, threadId, setBy: ENVIRONMENT, setAt: NOW };
const KEY = "scratch approval key";
const id = ProviderInstanceId.make;
const model = (instanceId: string, slug: string) => createModelSelection(id(instanceId), slug);

const provider = (instanceId: string, driver: string): ServerProvider => ({
  instanceId: id(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: [],
  slashCommands: [],
  skills: [],
});

const BOARD_LINEUP: DeliveryOrchestrationConfig = {
  team: "development",
  participants: [
    { seat: "builder", role: "developer", modelSelection: model("kimi", "kimi-k3") },
    { seat: "reviewer", role: "reviewer", modelSelection: model("codex", "gpt-astra") },
  ],
};

function setup({
  policy = undefined as DeliveryOrchestrationConfig["limitedSeat"],
  favorites = [
    ["kimi", "kimi-k3"],
    ["deepseek", "deepseek-v4"],
  ] as ReadonlyArray<readonly [string, string]>,
  bound = true,
  lineage = {} as Record<string, unknown>,
  ordinary = false,
  limitedSeat = false,
  limitedScout = false,
  /** The hand-off's fork lands but its first turn has not: the window a status read can fall in. */
  startsNoTurn = false,
  leadPick = undefined as "picked" | "none-free" | "moved" | "refused" | "not-found" | undefined,
  dropFirstPut = false,
} = {}) {
  const providers = [
    provider("claude", "claudeAgent"),
    provider("codex", "codex"),
    provider("kimi", "kimi"),
    provider("deepseek", "deepseek"),
  ];
  const lineups = new Map<string, DeliveryOrchestrationConfig>();
  if (!ordinary)
    lineups.set(threadId, {
      participants: [
        { seat: "critic", role: "reviewer", modelSelection: model("codex", "gpt-astra") },
        { seat: "scout", role: "researcher", modelSelection: model("deepseek", "deepseek-v4") },
      ],
      ...(policy ? { limitedSeat: policy } : {}),
    });
  // The board's team for its task's conversation, which a person's lineup above never replaces.
  const boardLineups = new Map<string, DeliveryOrchestrationConfig | null>(
    leadPick === undefined ? [] : [[threadId, BOARD_LINEUP]],
  );
  const binding = { team: "research", role: "lead", workspace: "/repo" };
  const bindings = new Map<string, unknown>(bound ? [[threadId, binding]] : []);
  const shell = {
    id: threadId,
    title: "Migration plan",
    projectId: ProjectId.make("project"),
    modelSelection: model("claude", "claude-fable"),
    lineage: leadPick === undefined ? lineage : { engineIntake: boardTaskThreadMarker(BOARD_TASK) },
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: RESET,
    latestRunId: runId,
    latestRunCompletedAt: DateTime.makeUnsafe("2026-11-22T11:59:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-11-22T11:59:00.000Z"),
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    snoozedUntil: null,
    limitRecovery: null as null | {
      runId: RunId;
      resetAt: string;
      autoResume: boolean;
      snooze?: boolean;
    },
  };
  // A fork keeps its source's model until its first turn lands, so the fake never updates it.
  const created = new Map<
    string,
    {
      id: ThreadId;
      modelSelection: unknown;
      deletedAt: null;
      archivedAt?: null;
      task?: BoardThreadRows.BoardThreadRow["task"] | null;
      runs: Array<unknown>;
    }
  >();
  const commands: Array<OrchestrationV2ServerCommand> = [];
  const calls: Array<string> = [];
  const writes: Array<Parameters<DeliveryService.DeliveryService["Service"]["boardThreadAct"]>[0]> =
    [];
  const messages = new Map<ThreadId, Set<string>>();
  let boardThread = OLD_LINK;
  let dropPut = dropFirstPut;
  const facts = (): LimitedSeatFacts => ({
    now: Date.parse(NOW),
    projectId: shell.projectId,
    providers,
    threadLimits: [
      { instanceId: id("claude"), model: "claude-fable", resetAt: RESET },
      ...(limitedSeat ? [{ instanceId: id("codex"), model: "gpt-astra", resetAt: RESET }] : []),
      ...(limitedScout
        ? [{ instanceId: id("deepseek"), model: "deepseek-v4", resetAt: RESET }]
        : []),
    ],
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: Object.fromEntries(
        providers.map((entry) => [entry.instanceId, { driver: entry.driver, enabled: true }]),
      ),
      favorites: favorites.map(([instanceId, slug]) => ({ provider: id(instanceId), model: slug })),
    },
  });
  const delivery = {
    read: () =>
      Effect.sync(() => ({
        body: {
          boardThread,
          title: "Ship the migration",
          body: "Keep the existing data.",
          acceptance: ["Existing records remain readable"],
          card: { run: { id: "engine-run", stage: "review" } },
        },
      })),
    boardThreadAct: (input: (typeof writes)[number]) =>
      Effect.suspend((): Effect.Effect<{ readonly body: unknown }, DeliveryError> => {
        writes.push(input);
        calls.push(input.method);
        if (input.method === "PUT") {
          if (dropPut) {
            dropPut = false;
            return Effect.fail(
              new DeliveryError({ reason: "unreachable", detail: "Disconnected" }),
            );
          }
          boardThread = { ...OLD_LINK, threadId: target };
          return Effect.succeed({ body: { boardThread } });
        }
        if (leadPick === "picked")
          return Effect.succeed({
            body: { leadPick: { harness: "kimi", model: "kimi-k3" } },
          });
        return Effect.fail(
          new DeliveryError({
            reason: "refused",
            status: leadPick === "refused" ? 403 : leadPick === "not-found" ? 404 : 409,
            detail: "Lead pick declined.",
            body: { code: leadPick },
          }),
        );
      }),
    threadState: (thread: ThreadId) =>
      Effect.succeed({
        binding: bindings.get(thread) ?? null,
        pending: null,
        ...(lineups.has(thread) ? { lineup: lineups.get(thread) } : {}),
      }),
    bindThread: (input: { threadId: ThreadId; driver: string; orchestration?: unknown }) =>
      Effect.sync(() => {
        calls.push(`bind:${input.threadId}:${input.driver}`);
        bindings.set(input.threadId, binding);
        lineups.set(input.threadId, input.orchestration as DeliveryOrchestrationConfig);
        return binding;
      }),
    setBoardLineup: (thread: ThreadId, lineup: DeliveryOrchestrationConfig | null) =>
      Effect.sync(() => {
        calls.push(`board-lineup:${thread}`);
        boardLineups.set(thread, lineup);
      }),
    boardLineupOf: (thread: ThreadId) => Effect.sync(() => boardLineups.get(thread)),
    setThreadLineup: (input: { threadId: ThreadId; orchestration: DeliveryOrchestrationConfig }) =>
      Effect.sync(() => {
        calls.push(`lineup:${input.threadId}`);
        lineups.set(input.threadId, input.orchestration);
        return {};
      }),
    boardApprovalKey: Effect.succeed(KEY),
  } as unknown as DeliveryService.DeliveryService["Service"];
  const projections = {
    getThreadShell: (thread: ThreadId) => Effect.succeed(thread === threadId ? shell : null),
    findThread: (thread: ThreadId) => Effect.sync(() => created.get(thread) ?? null),
    getMessagesById: (thread: ThreadId, ids: ReadonlyArray<string>) =>
      Effect.sync(
        () =>
          new Map(
            ids
              .filter((messageId) => messages.get(thread)?.has(messageId))
              .map((messageId) => [messageId, {}]),
          ),
      ),
    getThreadRecords: (thread: ThreadId) =>
      Effect.sync(() => ({
        runs:
          thread === threadId
            ? [{ id: runId, modelSelection: model("claude", "claude-sonnet") }]
            : (created.get(thread)?.runs ?? []),
      })),
  } as unknown as ProjectionStore.ProjectionStoreV2["Service"];
  const threads = {
    dispatch: (command: OrchestrationV2ServerCommand) =>
      Effect.sync(() => {
        commands.push(command);
        calls.push(command.type);
        if (command.type === "thread.fork" && !created.has(command.targetThreadId))
          created.set(command.targetThreadId, {
            id: command.targetThreadId,
            modelSelection: shell.modelSelection,
            deletedAt: null,
            runs: [],
          });
        if (command.type === "thread.create")
          created.set(command.threadId, {
            id: command.threadId,
            modelSelection: command.modelSelection,
            deletedAt: null,
            archivedAt: null,
            task: boardTaskOfMarker(command.engineIntake),
            runs: [],
          });
        if (command.type === "message.dispatch" && command.modelSelection && !startsNoTurn) {
          const sent = messages.get(command.threadId) ?? new Set<string>();
          sent.add(command.messageId);
          messages.set(command.threadId, sent);
          const runs = created.get(command.threadId)!.runs;
          if (runs.length === 0) runs.push({ modelSelection: command.modelSelection });
        }
        if (command.type === "thread.metadata.update" && command.limitRecovery)
          shell.limitRecovery = {
            runId: command.limitRecovery.runId,
            resetAt: command.limitRecovery.resetAt,
            autoResume: command.limitRecovery.autoResume ?? false,
          };
        return { sequence: commands.length, storedEvents: [] };
      }),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"];
  const boardRow = (id: ThreadId, task: BoardThreadRows.BoardThreadRow["task"]) => ({
    threadId: id,
    projectId: shell.projectId,
    title: shell.title,
    archivedAt: null,
    revision: 1,
    task,
    pullRequests: null,
    issues: null,
  });
  const layer = LimitedSeatSwap.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DeliveryService.DeliveryService, delivery),
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(ENVIRONMENT),
        }),
        Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
          listInstances: Effect.succeed(
            providers.map(({ instanceId, driver, enabled }) => ({
              instanceId,
              driverKind: driver,
              enabled,
            })),
          ),
        } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]),
        Layer.succeed(LimitedSeats.LimitedSeats, { facts: () => Effect.sync(facts) }),
        Layer.succeed(BoardThreadRows.BoardThreadRows, {
          list: ({ archived }) =>
            Effect.sync(() => {
              if (archived) return [];
              const rows = leadPick === undefined ? [] : [boardRow(threadId, BOARD_TASK)];
              for (const entry of created.values()) {
                if (entry.task != null) rows.push(boardRow(entry.id, entry.task));
              }
              return rows;
            }),
        }),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
        Layer.succeed(ThreadManagementService.ThreadManagementService, threads),
        Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
          get: (instanceId: ProviderInstanceId) =>
            Effect.succeed({
              driver: providers.find((entry) => entry.instanceId === instanceId)?.driver,
            }),
        } as unknown as ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]),
      ),
    ),
  );
  return { layer, shell, commands, calls, lineups, boardLineups, writes };
}

it.effect.each(["picked", "none-free", "moved", "refused", "not-found"] as const)(
  "hands a limited board lead on only when the engine returns a pick (%s)",
  (leadPick) => {
    const fixture = setup({ leadPick });
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const swaps = yield* LimitedSeatSwap.LimitedSeatSwap;
      expect(yield* swaps.handOffLimitedLead(threadId)).toBe(leadPick === "picked" ? target : null);
      const post = {
        method: "POST",
        path: "/api/tasks/task-7/lead-pick",
        body: {
          limited: { harness: "claude", model: "claude-sonnet" },
          reason: "usage-limit",
          setBy: ENVIRONMENT,
          key: KEY,
        },
      };
      if (leadPick !== "picked") {
        expect(fixture.writes).toEqual([post]);
        expect(fixture.commands).toEqual([]);
        return;
      }
      expect(yield* swaps.handOffLimitedLead(threadId)).toBeNull();
      expect(fixture.calls).toEqual([
        "POST",
        "thread.create",
        // The successor is the board's from its start, with the board's team for the lead.
        `board-lineup:${target}`,
        "thread.metadata.update",
        "message.dispatch",
        "PUT",
      ]);
      expect(fixture.writes).toEqual([
        post,
        {
          method: "PUT",
          path: "/api/tasks/task-7/board-thread",
          body: {
            environmentId: ENVIRONMENT,
            threadId: target,
            setBy: ENVIRONMENT,
            expect: OLD_LINK,
            key: KEY,
          },
        },
      ]);
      expect(fixture.commands).toMatchObject([
        {
          type: "thread.create",
          threadId: target,
          projectId: fixture.shell.projectId,
          engineIntake: boardTaskThreadMarker(BOARD_TASK),
          modelSelection: model("kimi", "kimi-k3"),
        },
        {
          type: "thread.metadata.update",
          threadId,
          limitRecovery: { runId, resetAt: RESET, autoResume: false },
        },
        {
          type: "message.dispatch",
          threadId: target,
          modelSelection: model("kimi", "kimi-k3"),
          // An engine notice, so the successor's lineup starts no team round on it.
          notification: { source: { kind: "system" }, outcome: "updated" },
          createdBy: "agent",
          dispatchMode: { type: "queue_after_active" },
          text: expect.stringMatching(
            /usage limit[\s\S]*Ship the migration[\s\S]*Keep the existing data[\s\S]*Existing records remain readable[\s\S]*engine-run[\s\S]*review/,
          ),
        },
      ]);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect("retries an uncommitted board link move using the existing successor and turn", () => {
  const fixture = setup({ leadPick: "picked", dropFirstPut: true });
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const swaps = yield* LimitedSeatSwap.LimitedSeatSwap;
    expect(yield* swaps.handOffLimitedLead(threadId)).toBeNull();
    expect(yield* swaps.handOffLimitedLead(threadId)).toBe(target);
    expect(yield* swaps.handOffLimitedLead(threadId)).toBeNull();
    expect(fixture.calls).toEqual([
      "POST",
      "thread.create",
      `board-lineup:${target}`,
      "thread.metadata.update",
      "message.dispatch",
      "PUT",
      "PUT",
    ]);
    // Only the board's lineup goes on: never the one a person saved on the lead's thread.
    expect(fixture.boardLineups.get(target)).toEqual(BOARD_LINEUP);
    expect(fixture.lineups.has(target)).toBe(false);
    expect(fixture.writes[2]).toEqual(fixture.writes[1]);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("hands a limited lead on to a linked thread on the first free favorite", () => {
  const fixture = setup();
  return Effect.gen(function* () {
    const swaps = yield* LimitedSeatSwap.LimitedSeatSwap;
    expect(yield* swaps.handOffLimitedLead(threadId)).toBe(target);
    // Bound to the team first, disarmed, forked from the failed run, and only then started.
    expect(fixture.calls).toEqual([
      `bind:${target}:kimi`,
      "thread.metadata.update",
      "thread.fork",
      "message.dispatch",
    ]);
    expect(fixture.commands[1]).toMatchObject({
      sourceThreadId: threadId,
      targetThreadId: target,
      sourcePoint: { type: "run", runId },
    });
    expect(fixture.commands[2]).toMatchObject({
      threadId: target,
      text: LimitedSeatSwap.LEAD_HANDOFF_MESSAGE,
      // Deepseek is a favorite too, but a seat of the conversation already runs it.
      modelSelection: { instanceId: "kimi", model: "kimi-k3" },
    });
    expect(fixture.lineups.get(target)).toEqual(fixture.lineups.get(threadId));
    expect((yield* swaps.status(threadId)).notices).toEqual([
      expect.objectContaining({ seat: null, state: "swapped", continuedIn: target }),
    ]);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("names the model the hand-off started, not the one the fork inherited", () => {
  const fixture = setup({ limitedSeat: true });
  return Effect.gen(function* () {
    const swaps = yield* LimitedSeatSwap.LimitedSeatSwap;
    yield* swaps.handOffLimitedLead(threadId);
    // The old thread runs no more turns: its limited seat is offered no swap there.
    expect((yield* swaps.status(threadId)).notices).toEqual([
      {
        seat: null,
        state: "swapped",
        continuedIn: target,
        limited: expect.objectContaining({ model: "claude-fable" }),
        substitute: { instanceId: "kimi", model: "kimi-k3" },
      },
    ]);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("names the substitute about to start while the fork has no turn yet", () => {
  const fixture = setup({ startsNoTurn: true });
  return Effect.gen(function* () {
    const swaps = yield* LimitedSeatSwap.LimitedSeatSwap;
    yield* swaps.handOffLimitedLead(threadId);
    expect((yield* swaps.status(threadId)).notices).toEqual([
      expect.objectContaining({
        state: "swapped",
        substitute: { instanceId: "kimi", model: "kimi-k3" },
      }),
    ]);
    // Asked again, the turn that never landed is sent on the substitute, not the limited model.
    yield* swaps.handOffLimitedLead(threadId);
    expect(fixture.commands.at(-1)).toMatchObject({
      type: "message.dispatch",
      modelSelection: { instanceId: "kimi", model: "kimi-k3" },
    });
  }).pipe(Effect.provide(fixture.layer));
});

it.effect(
  "disarms the old thread's limit recovery, so the same work is never resumed there",
  () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const resumes = () =>
        limitRecoveryCommand(fixture.shell as never, true, Date.parse("2026-11-22T18:00:00.000Z"));
      // Left alone, the recovery worker arms the thread and later sends its resume.
      expect(resumes()).toMatchObject({ type: "thread.metadata.update" });
      yield* (yield* LimitedSeatSwap.LimitedSeatSwap).handOffLimitedLead(threadId);
      expect(fixture.commands[0]).toMatchObject({
        type: "thread.metadata.update",
        threadId,
        limitRecovery: { runId, resetAt: RESET, autoResume: false, snooze: false },
      });
      expect(resumes()).toBeNull();
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect("makes one thread however often the swap is asked for", () => {
  const fixture = setup({ policy: "ask" });
  return Effect.gen(function* () {
    const swaps = yield* LimitedSeatSwap.LimitedSeatSwap;
    const [offer] = (yield* swaps.status(threadId)).notices;
    expect(offer).toMatchObject({ seat: null, state: "offered", substitute: { model: "kimi-k3" } });
    // Ask me never hands on by itself.
    expect(yield* swaps.handOffLimitedLead(threadId)).toBeNull();
    expect(fixture.commands).toHaveLength(0);
    const input = { threadId, seat: null, modelSelection: offer!.substitute! };
    expect(yield* swaps.swap(input)).toEqual({ continuedIn: target });
    expect(yield* swaps.swap(input)).toEqual({ continuedIn: target });
    const ids = fixture.commands.map((command) => command.commandId);
    // The second click repeats the same commands, which the orchestrator answers from receipts.
    expect(ids.slice(3)).toEqual([ids[1], ids[2]]);
    expect(new Set(ids).size).toBe(3);
    expect(fixture.calls.filter((call) => call.startsWith("bind:"))).toHaveLength(1);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("leaves the lead as it failed, with a notice, when no favorite is free", () => {
  const fixture = setup({ favorites: [["deepseek", "deepseek-v4"]] });
  return Effect.gen(function* () {
    const swaps = yield* LimitedSeatSwap.LimitedSeatSwap;
    expect(yield* swaps.handOffLimitedLead(threadId)).toBeNull();
    expect(fixture.calls).toEqual([]);
    expect((yield* swaps.status(threadId)).notices).toEqual([
      { seat: null, state: "none-free", substitute: null, limited: expect.anything() },
    ]);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("refuses a model that is not a free favorite", () => {
  const fixture = setup({ policy: "ask" });
  return Effect.gen(function* () {
    const swaps = yield* LimitedSeatSwap.LimitedSeatSwap;
    const refusal = yield* Effect.flip(
      swaps.swap({ threadId, seat: null, modelSelection: model("codex", "gpt-sol") }),
    );
    expect(refusal.detail).toContain("no longer free");
    expect(fixture.calls).toEqual([]);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("carries the lineup to a conversation bound to no team", () => {
  const fixture = setup({ bound: false });
  return Effect.gen(function* () {
    yield* (yield* LimitedSeatSwap.LimitedSeatSwap).handOffLimitedLead(threadId);
    expect(fixture.calls[0]).toBe(`lineup:${target}`);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("records the substitute a person agreed to for a seat, once", () => {
  const fixture = setup({ policy: "ask", limitedSeat: true });
  return Effect.gen(function* () {
    const swaps = yield* LimitedSeatSwap.LimitedSeatSwap;
    const offer = (yield* swaps.status(threadId)).notices.find(
      (notice) => notice.seat === "critic",
    );
    expect(offer).toMatchObject({ state: "offered", substitute: { model: "kimi-k3" } });
    const input = { threadId, seat: "critic", modelSelection: offer!.substitute! };
    expect(yield* swaps.swap(input)).toEqual({ continuedIn: null });
    expect(yield* swaps.swap(input)).toEqual({ continuedIn: null });
    expect(fixture.calls).toEqual([`lineup:${threadId}`]);
    expect(fixture.lineups.get(threadId)?.participants[0]?.substitute).toEqual(offer!.substitute);
    expect(
      (yield* swaps.status(threadId)).notices.find((notice) => notice.seat === "critic"),
    ).toMatchObject({ state: "swapped", substitute: { model: "kimi-k3" } });
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("never offers a seat the model another seat stands in on", () => {
  const fixture = setup({ policy: "ask", limitedSeat: true, limitedScout: true });
  return Effect.gen(function* () {
    const swaps = yield* LimitedSeatSwap.LimitedSeatSwap;
    const kimi = model("kimi", "kimi-k3");
    const noticeFor = (seat: string) =>
      Effect.map(swaps.status(threadId), (status) =>
        status.notices.find((notice) => notice.seat === seat),
      );
    expect(yield* noticeFor("scout")).toMatchObject({ state: "offered", substitute: kimi });
    yield* swaps.swap({ threadId, seat: "critic", modelSelection: kimi });
    expect(yield* noticeFor("critic")).toMatchObject({ state: "swapped", substitute: kimi });
    expect(yield* noticeFor("scout")).toMatchObject({ state: "none-free", substitute: null });
    const refused = yield* Effect.flip(
      swaps.swap({ threadId, seat: "scout", modelSelection: kimi }),
    );
    expect(refused.detail).toBe("kimi-k3 is no longer free. Choose again from the notice.");
    expect(fixture.lineups.get(threadId)?.participants[1]?.substitute).toBeUndefined();
  }).pipe(Effect.provide(fixture.layer));
});

it.effect.each([
  { name: "an ordinary chat", options: { ordinary: true } },
  { name: "a board task's conversation", options: { lineage: { engineIntake: "task-1" } } },
])("does not govern $name", ({ options }) => {
  const fixture = setup(options);
  return Effect.gen(function* () {
    const swaps = yield* LimitedSeatSwap.LimitedSeatSwap;
    expect(yield* swaps.status(threadId)).toEqual({ policy: null, notices: [] });
    expect(yield* swaps.handOffLimitedLead(threadId)).toBeNull();
    expect(fixture.calls).toEqual([]);
  }).pipe(Effect.provide(fixture.layer));
});
