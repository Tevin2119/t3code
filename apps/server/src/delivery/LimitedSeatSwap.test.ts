import {
  DEFAULT_SERVER_SETTINGS,
  type DeliveryOrchestrationConfig,
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

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { limitRecoveryCommand } from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as DeliveryService from "./DeliveryService.ts";
import * as LimitedSeats from "./LimitedSeats.ts";
import * as LimitedSeatSwap from "./LimitedSeatSwap.ts";

const threadId = ThreadId.make("lead-thread");
const runId = RunId.make("lead-run");
const target = LimitedSeatSwap.leadHandoffThreadId(runId);
const NOW = "2026-11-22T12:00:00.000Z";
const RESET = "2026-11-22T17:00:00.000Z";
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
  const binding = { team: "research", role: "lead", workspace: "/repo" };
  const bindings = new Map<string, unknown>(bound ? [[threadId, binding]] : []);
  const shell = {
    id: threadId,
    title: "Migration plan",
    projectId: ProjectId.make("project"),
    modelSelection: model("claude", "claude-fable"),
    lineage,
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
  const created = new Map<string, { id: ThreadId; modelSelection: unknown }>();
  const commands: Array<OrchestrationV2ServerCommand> = [];
  const calls: Array<string> = [];
  const facts = (): LimitedSeatFacts => ({
    now: Date.parse(NOW),
    projectId: shell.projectId,
    providers,
    threadLimits: [
      { instanceId: id("claude"), model: "claude-fable", resetAt: RESET },
      ...(limitedSeat ? [{ instanceId: id("codex"), model: "gpt-astra", resetAt: RESET }] : []),
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
    setThreadLineup: (input: { threadId: ThreadId; orchestration: DeliveryOrchestrationConfig }) =>
      Effect.sync(() => {
        calls.push(`lineup:${input.threadId}`);
        lineups.set(input.threadId, input.orchestration);
        return {};
      }),
  } as unknown as DeliveryService.DeliveryService["Service"];
  const projections = {
    getThreadShell: (thread: ThreadId) => Effect.succeed(thread === threadId ? shell : null),
    findThread: (thread: ThreadId) => Effect.sync(() => created.get(thread) ?? null),
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
          });
        if (command.type === "message.dispatch" && command.modelSelection)
          created.get(command.threadId)!.modelSelection = command.modelSelection;
        if (command.type === "thread.metadata.update" && command.limitRecovery)
          shell.limitRecovery = {
            runId: command.limitRecovery.runId,
            resetAt: command.limitRecovery.resetAt,
            autoResume: command.limitRecovery.autoResume ?? false,
          };
        return { sequence: commands.length, storedEvents: [] };
      }),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"];
  const layer = LimitedSeatSwap.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DeliveryService.DeliveryService, delivery),
        Layer.succeed(LimitedSeats.LimitedSeats, { facts: () => Effect.sync(facts) }),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
        Layer.succeed(ThreadManagementService.ThreadManagementService, threads),
        Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
          get: (instanceId: ProviderInstanceId) => Effect.succeed({ driver: instanceId }),
        } as unknown as ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]),
      ),
    ),
  );
  return { layer, shell, commands, calls, lineups };
}

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
