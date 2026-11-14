import {
  EnvironmentId,
  isListedThreadLineage,
  ModelSelection,
  ProjectId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeliveryService from "./DeliveryService.ts";
import * as NativeIntake from "./NativeIntake.ts";

const decodeSelection = Schema.decodeUnknownSync(ModelSelection);
function setup({
  empty = false,
  foreign = false,
  lostAttach = false,
  cancelled = false,
  complete = false,
  earlyVerifier = false,
  wrongModel = false,
  admissionFails = false,
} = {}) {
  const id = `intake-${"a".repeat(64)}`;
  const threadId = ThreadId.make(`engine:${id}:0`);
  const seats = [
    {
      id: "lead",
      providerInstanceId: "codex",
      model: "gpt-6-astra",
      options: { reasoningEffort: "high" },
    },
    {
      id: "reproduction",
      providerInstanceId: "codex",
      model: "gpt-6.1-sol",
      options: { reasoningEffort: "high" },
    },
    {
      id: "data-infrastructure",
      providerInstanceId: "codex",
      model: "gpt-6-astra",
      options: { reasoningEffort: "high" },
    },
    {
      id: "independent-verifier",
      providerInstanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: { effort: "high" },
    },
  ];
  const select = (index: number) =>
    decodeSelection({
      instanceId: seats[index]!.providerInstanceId,
      model: seats[index]!.model,
      options: seats[index]!.options,
    });
  const profile = {
    profile: "payoutlab-discord-triage",
    runtime: "t3-native",
    paperclip: {
      board: "payoutlab-discord-bugs",
      team: "payoutlab-discord-triage",
      workflow: "plan",
    },
    repositories: { planningTarget: "C:/planning" },
    nativeSeats: seats,
  };
  let job = {
    id,
    generation: 0,
    state: "queued",
    owner: foreign ? "another-owner" : (null as string | null),
    native: null as { threadId: string; runId: string } | null,
    cancelRequested: false,
    profilePath: "C:/intake/config.json",
    projectId: "project",
    ...profile.paperclip,
    workspace: "C:/planning",
    ticketId: "ticket",
    digest: "digest",
    evidencePath: "C:/evidence.json",
    prompt: "Investigate evidence.",
    seats,
  };
  const commands = new Map<string, OrchestrationV2ServerCommand>();
  const completions: Array<Record<string, unknown>> = [];
  const at = (minute: number) =>
    DateTime.makeUnsafe(`2026-11-14T10:${String(minute).padStart(2, "0")}:00Z`);
  const tasks = seats.slice(1).map((seat, index) => ({
    prompt: `[native-intake:${id}:${seat.id}] Investigate`,
    childThreadId: `child-${index + 1}`,
    status: "completed",
    startedAt: at(index === 2 && !earlyVerifier ? 3 : 0),
    completedAt: at(index === 2 ? 4 : 2),
  }));
  const projection = {
    thread: { lineage: { engineIntake: `${id}:0` }, modelSelection: select(0) },
    runs: [
      {
        id: "run",
        ordinal: 1,
        status: complete ? "completed" : "running",
        modelSelection: select(0),
      },
    ],
    subagents: complete ? tasks : [],
    runtimeRequests: [],
    messages: [
      { role: "assistant", runId: "run", streaming: false, text: "progress" },
      { role: "assistant", runId: "run", streaming: false, text: '{"verdict":"likely_bug"}' },
    ],
  };
  const delivery = {
    read: ({ path }: { path: string }) =>
      Effect.succeed({
        body:
          path === "/api/native-intakes"
            ? { version: 1, enabled: true, pending: empty ? [] : [job] }
            : job,
      }),
    nativeIntakeAct: ({ path, body }: { path: string; body: Record<string, unknown> }) => {
      if (path.endsWith("/cancel")) job = { ...job, cancelRequested: true };
      if (path.endsWith("/claim"))
        job = { ...job, owner: String(body.owner), cancelRequested: cancelled };
      if (path.endsWith("/attach")) {
        if (lostAttach) {
          lostAttach = false;
          return Effect.fail(new NativeIntake.NativeIntakeError({ reason: "transport" }));
        }
        job = { ...job, native: { threadId: String(body.threadId), runId: String(body.runId) } };
      }
      if (path.endsWith("/complete") || path.endsWith("/abandon")) {
        completions.push(body);
        job = { ...job, state: path.endsWith("/abandon") ? "cancelled" : String(body.state) };
      }
      return Effect.succeed({ body: job });
    },
  } as unknown as DeliveryService.DeliveryService["Service"];
  const service = NativeIntake.make.pipe(
    Effect.provideService(ServerSettings.ServerSettingsService, {
      getSettings: Effect.succeed({
        delivery: {
          enabled: true,
          nativeIntake: {
            enabled: true,
            profilePath: job.profilePath,
            projectId: ProjectId.make("project"),
          },
        },
      }),
    } as unknown as ServerSettings.ServerSettingsService["Service"]),
    Effect.provideService(DeliveryService.DeliveryService, delivery),
    Effect.provide(
      FileSystem.layerNoop({ readFileString: () => Effect.succeed(JSON.stringify(profile)) }),
    ),
    Effect.provideService(HostProcess.Platform, "win32"),
    Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
    }),
    Effect.provideService(ThreadManagementService.ThreadManagementService, {
      hasReceipt: (commandId: string) => Effect.succeed(commands.has(commandId)),
      dispatch: (command: OrchestrationV2ServerCommand) => {
        if (admissionFails && command.type === "message.dispatch")
          return Effect.fail(new NativeIntake.NativeIntakeError({ reason: "roster" }));
        commands.set(command.commandId, command);
        return Effect.succeed({
          storedEvents:
            command.type === "message.dispatch"
              ? [{ event: { type: "run.created", payload: { id: "run" } } }]
              : [],
        });
      },
    } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    Effect.provideService(ProjectionStore.ProjectionStoreV2, {
      getThreadRecords: (requested: string) => {
        if (requested === threadId) return Effect.succeed(projection);
        const index = Number(requested.slice(-1));
        const selected = wrongModel && index === 3 ? select(1) : select(index);
        return Effect.succeed({
          thread: { modelSelection: selected },
          runs: [{ modelSelection: selected }],
          subagents: [],
        });
      },
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
    Effect.provideService(Orchestrator.OrchestratorV2, {
      streamDomainEvents: Stream.empty,
    } as unknown as Orchestrator.OrchestratorV2["Service"]),
  );
  return { service, commands, completions, projection, threadId, profile };
}

it.effect("refused provider admission releases the engine claim without inventing a run", () =>
  Effect.gen(function* () {
    const f = setup({ admissionFails: true });
    yield* (yield* f.service).reconcile().pipe(Effect.flip);
    expect(f.commands.size).toBe(1);
    expect(f.completions[0]?.reason).toBe(
      "Native provider admission failed before a run was accepted.",
    );
  }),
);

it.effect("a changed binding cancels existing owned work without admitting a replacement", () =>
  Effect.gen(function* () {
    const f = setup();
    const service = yield* f.service;
    yield* service.reconcile();
    f.profile.repositories.planningTarget = "C:/other-project";
    yield* service.reconcile();
    expect(
      [...f.commands.values()].filter((command) => command.type === "message.dispatch"),
    ).toHaveLength(1);
    expect([...f.commands.values()].some((command) => command.type === "thread.stop")).toBe(true);
  }),
);

it.effect("extra specialist work and a changed lead configuration cannot be published", () =>
  Effect.gen(function* () {
    const extra = setup({ complete: true });
    extra.projection.subagents.push(extra.projection.subagents[0]!);
    yield* (yield* extra.service).reconcile();
    expect(extra.completions[0]?.state).toBe("failed");
    const switched = setup({ complete: true });
    switched.projection.runs[0]!.modelSelection = decodeSelection({
      instanceId: "codex",
      model: "another-model",
    });
    yield* (yield* switched.service).reconcile();
    expect(switched.completions[0]?.state).toBe("failed");
  }),
);

it.effect("empty evidence and another owner's lease start no native threads", () =>
  Effect.gen(function* () {
    for (const options of [{ empty: true }, { foreign: true }]) {
      const f = setup(options);
      yield* (yield* f.service).reconcile();
      expect(f.commands.size).toBe(0);
    }
  }),
);
it.effect("lost attach recovery reuses the native admission receipts", () =>
  Effect.gen(function* () {
    const f = setup({ lostAttach: true });
    const service = yield* f.service;
    yield* service.reconcile().pipe(Effect.flip);
    yield* service.reconcile();
    expect(f.commands.size).toBe(2);
    expect(f.completions).toEqual([]);
    const create = [...f.commands.values()].find((command) => command.type === "thread.create");
    expect(create?.type === "thread.create" && create.engineIntake).toBe(
      `intake-${"a".repeat(64)}:0`,
    );
  }),
);
it.effect("cancellation after claim never admits a new provider run", () =>
  Effect.gen(function* () {
    const f = setup({ cancelled: true });
    yield* (yield* f.service).reconcile();
    expect(f.commands.size).toBe(0);
    expect(f.completions).toHaveLength(1);
  }),
);
it.effect("only the final report is returned after the configured native team finishes", () =>
  Effect.gen(function* () {
    const f = setup({ complete: true });
    yield* (yield* f.service).reconcile();
    expect(f.completions[0]).toMatchObject({
      state: "completed",
      text: '{"verdict":"likely_bug"}',
    });
  }),
);
it.effect("rejects model substitution and verification before evidence work finishes", () =>
  Effect.gen(function* () {
    for (const options of [{ wrongModel: true }, { earlyVerifier: true }]) {
      const f = setup({ complete: true, ...options });
      yield* (yield* f.service).reconcile();
      expect(f.completions[0]?.state).toBe("failed");
    }
  }),
);
it("engine histories remain addressable but never enter conversation or notification lists", () => {
  const threadId = ThreadId.make("engine-job");
  expect(
    isListedThreadLineage({
      rootThreadId: threadId,
      parentThreadId: null,
      relationshipToParent: null,
      engineIntake: "job",
    }),
  ).toBe(false);
  expect(
    isListedThreadLineage({
      rootThreadId: threadId,
      parentThreadId: null,
      relationshipToParent: null,
    }),
  ).toBe(true);
});
