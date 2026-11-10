import {
  NodeId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { createModelSelection } from "@t3tools/shared/model";
import * as DeliveryService from "./DeliveryService.ts";
import * as NativeTeamChat from "./NativeTeamChat.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

const threadId = ThreadId.make("team-parent");
const runId = RunId.make("team-turn");
type Delegation = Extract<
  OrchestrationV2ServerCommand,
  { type: "delegated_task.request"; teamChat: unknown }
>;

function setup({
  plain = false,
  uncertain = false,
  unavailable = false,
  critique = undefined as "first" | "always" | "never" | undefined,
} = {}) {
  const participants = [
    {
      seat: "researcher",
      role: "researcher",
      modelSelection: createModelSelection(ProviderInstanceId.make("claude-work"), "claude-model"),
    },
    {
      seat: "critic",
      role: "reviewer",
      modelSelection: createModelSelection(ProviderInstanceId.make("codex-work"), "codex-model", [
        { id: "reasoningEffort", value: "high" },
      ]),
    },
  ];
  const binding = {
    team: "research",
    configuration: "research@3#abc",
    workspace: "C:/workspace",
    ...(plain ? {} : { orchestration: { participants, ...(critique ? { critique } : {}) } }),
  };
  const message = {
    id: MessageId.make("question"),
    role: "user",
    text: "Assess the migration risk.",
    attachments: [] as ChatAttachment[],
  };
  const run = {
    id: runId,
    rootNodeId: NodeId.make("root"),
    ordinal: 1,
    status: "starting",
    userMessageId: message.id,
  };
  const tasks: Array<{
    teamChat: Delegation["teamChat"];
    status: string;
    result: string | null;
    providerInstanceId: ProviderInstanceId;
    model: string;
  }> = [];
  const admissions = new Map<string, Delegation>();
  const bindings: Array<{ threadId: ThreadId; role?: string; driver: string }> = [];
  const delivery = {
    threadState: () => Effect.succeed({ binding, pending: null }),
    bindThread: (input: { threadId: ThreadId; role?: string; driver: string }) => {
      bindings.push(input);
      return Effect.succeed({ configuration: binding.configuration });
    },
  } as unknown as DeliveryService.DeliveryService["Service"];
  const projections = {
    getThreadRecords: () =>
      Effect.succeed({
        thread: { worktreePath: null, projectId: ProjectId.make("project") },
        runs: [run],
        messages: [message],
        subagents: tasks,
      }),
  } as unknown as ProjectionStore.ProjectionStoreV2["Service"];
  const threads = {
    isProviderInstanceEnabledForProject: () => Effect.succeed(true),
    dispatch: (command: Delegation) =>
      Effect.suspend(() => {
        admissions.set(command.commandId, command);
        if (uncertain) {
          uncertain = false;
          return Effect.fail(new NativeTeamChat.NativeTeamChatError({ runId, reason: "dispatch" }));
        }
        tasks.push({
          teamChat: command.teamChat,
          status: "running",
          result: null,
          providerInstanceId: command.modelSelection!.instanceId,
          model: command.modelSelection!.model,
        });
        return Effect.succeed({});
      }),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"];
  const adapters = {
    get: (instanceId: ProviderInstanceId) =>
      unavailable && instanceId === "codex-work"
        ? Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          )
        : Effect.succeed({ driver: instanceId === "claude-work" ? "claudeAgent" : "codex" }),
  } as unknown as ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"];
  const instances = {
    getInstance: () =>
      Effect.succeed({
        enabled: true,
        snapshot: {
          getSnapshot: Effect.succeed({
            installed: true,
            supportedRuntimeModes: ["approval-required"],
          }),
        },
      }),
  } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
  return {
    run,
    message,
    tasks,
    admissions,
    bindings,
    participants,
    service: NativeTeamChat.make.pipe(
      Effect.provideService(DeliveryService.DeliveryService, delivery),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      Effect.provideService(ProviderAdapterRegistry.ProviderAdapterRegistryV2, adapters),
      Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, instances),
      Effect.provide(IdAllocator.layer),
    ),
  };
}

it.effect("recovers a lost dispatch receipt and shares independent results before synthesis", () =>
  Effect.gen(function* () {
    const fixture = setup({ uncertain: true });
    const service = yield* fixture.service;
    yield* service.prepareTurn({ threadId, runId }).pipe(Effect.flip);
    expect((yield* service.prepareTurn({ threadId, runId })).ready).toBe(false);
    expect(fixture.admissions.size).toBe(2);
    expect([...fixture.admissions.values()].map((command) => command.modelSelection)).toEqual(
      fixture.participants.map((seat) => seat.modelSelection),
    );
    expect(new Set(fixture.bindings.map((binding) => binding.threadId)).size).toBe(2);
    expect(fixture.bindings.map((binding) => binding.driver)).toContain("claudeAgent");
    expect(fixture.bindings.map((binding) => binding.driver)).toContain("codex");
    expect((yield* service.prepareTurn({ threadId, runId })).ready).toBe(false);
    expect(fixture.admissions.size).toBe(2);
    fixture.tasks[0]!.status = "completed";
    fixture.tasks[0]!.result = "Migration loses audit history.";
    fixture.tasks[1]!.status = "failed";
    expect((yield* service.prepareTurn({ threadId, runId })).ready).toBe(false);
    const critiques = [...fixture.admissions.values()].filter(
      (command) => command.teamChat?.stage === "critique",
    );
    expect(critiques).toHaveLength(2);
    for (const critique of critiques) {
      expect(critique.task).toContain("Migration loses audit history.");
      expect(critique.task).toContain("codex-work/codex-model, failed");
    }
    for (const task of fixture.tasks.filter((task) => task.teamChat?.stage === "critique")) {
      task.status = "completed";
      task.result = "Preserve the audit log before migration.";
    }
    const final = yield* service.prepareTurn({ threadId, runId });
    expect(final.ready).toBe(true);
    expect(final.context).toContain("Migration loses audit history.");
    expect(final.context).toContain("Preserve the audit log before migration.");
    expect(final.context).toContain("codex-work/codex-model, failed");
    expect(fixture.admissions.size).toBe(4);
  }),
);

it.effect("critiques on the first message only unless the conversation asks otherwise", () =>
  Effect.gen(function* () {
    const settle = (fixture: ReturnType<typeof setup>) => {
      for (const task of fixture.tasks) {
        task.status = "completed";
        task.result = "Finding.";
      }
    };
    const earlier = {
      teamChat: {
        sourceRunId: RunId.make("earlier-turn"),
        stage: "contribution" as const,
        seat: "researcher",
      },
      status: "completed",
      result: "Earlier finding.",
      providerInstanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-model",
    };

    const followUp = setup();
    followUp.tasks.push(earlier);
    const service = yield* followUp.service;
    yield* service.prepareTurn({ threadId, runId });
    settle(followUp);
    const final = yield* service.prepareTurn({ threadId, runId });
    expect(final.ready).toBe(true);
    expect(final.context).not.toContain("Critiques:");
    expect(final.context).not.toContain("Earlier finding.");
    expect(followUp.admissions.size).toBe(2);

    const always = setup({ critique: "always" });
    always.tasks.push(earlier);
    const alwaysService = yield* always.service;
    yield* alwaysService.prepareTurn({ threadId, runId });
    settle(always);
    expect((yield* alwaysService.prepareTurn({ threadId, runId })).ready).toBe(false);
    expect(always.admissions.size).toBe(4);

    const never = setup({ critique: "never" });
    const neverService = yield* never.service;
    yield* neverService.prepareTurn({ threadId, runId });
    settle(never);
    expect((yield* neverService.prepareTurn({ threadId, runId })).ready).toBe(true);
    expect(never.admissions.size).toBe(2);
  }),
);

it.effect("leaves ordinary chat alone and cannot launch a new round after interruption", () =>
  Effect.gen(function* () {
    const plain = setup({ plain: true });
    const plainService = yield* plain.service;
    expect(yield* plainService.prepareTurn({ threadId, runId })).toEqual({
      ready: true,
      context: "",
    });
    expect(plain.admissions.size).toBe(0);
    const stopped = setup();
    stopped.run.status = "interrupted";
    const stoppedService = yield* stopped.service;
    expect((yield* stoppedService.prepareTurn({ threadId, runId })).ready).toBe(false);
    expect(stopped.admissions.size).toBe(0);
  }),
);

it.effect("refuses an unavailable selected provider before launching any participant", () =>
  Effect.gen(function* () {
    const fixture = setup({ unavailable: true });
    const service = yield* fixture.service;
    yield* service.prepareTurn({ threadId, runId }).pipe(Effect.flip);
    expect(fixture.admissions.size).toBe(0);
    expect(fixture.bindings).toEqual([]);
  }),
);
it.effect(
  "does not send compaction controls or unreadable attachments to the discussion roster",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      fixture.message.text = "/compact";
      const service = yield* fixture.service;
      expect(yield* service.prepareTurn({ threadId, runId })).toEqual({ ready: true, context: "" });
      expect(fixture.admissions.size).toBe(0);
      fixture.message.text = "Assess this image.";
      fixture.message.attachments.push({
        type: "image",
        id: "image",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 12,
      });
      yield* service.prepareTurn({ threadId, runId }).pipe(Effect.flip);
      expect(fixture.admissions.size).toBe(0);
    }),
);
