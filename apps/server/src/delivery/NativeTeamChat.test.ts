import {
  EnvironmentId,
  NodeId,
  DeliveryError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  RunAttemptId,
  type OrchestrationV2TurnItem,
  type ChatAttachment,
  type OrchestrationV2ServerCommand,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  threadContextRecord,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import type { LimitedSeatFacts } from "@t3tools/shared/limitedSeat";
import { createModelSelection } from "@t3tools/shared/model";
import { ServerConfig } from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { engineNotice } from "./BoardConversation.ts";
import {
  briefMessageId,
  engineStageNotice,
  seatCommandId,
  stageMessageId,
} from "./boardTaskAttempts.ts";
import { boardTaskOf, boardTaskThreadId, boardTaskThreadMarker } from "./boardThreadMarker.ts";
import * as DeliveryService from "./DeliveryService.ts";
import * as LimitedSeats from "./LimitedSeats.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
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
  disabled = false,
  disabledSeats = () => new Set<string>(),
  mismatchSeat = undefined as string | undefined,
  third = false,
  bindFailures = [] as string[],
  noWorkspace = false,
  noticeCommitted = true,
  missingRun = false,
  bindStatus = undefined as number | undefined,
  critique = undefined as "first" | "always" | "never" | undefined,
  access = undefined as "approval-required" | "full-access" | undefined,
  /** The researcher's own access, over the conversation's. */
  seatAccess = undefined as "read-only" | "approval-required" | "full-access" | undefined,
  threadAccess = "full-access",
  fullAccessOnly = false,
  /** A conversation bound to no team; `callsTeam` names one for its participants. */
  unbound = false,
  callsTeam = undefined as string | undefined,
  participantConfiguration = "research@3#abc",
  /** What T3 knows about limits and Favorites; absent, no seat is ever treated as limited. */
  limitFacts = undefined as (() => LimitedSeatFacts) | undefined,
  boardOwned = false,
  /** The server-owned marker the thread was made with, over `boardOwned`'s. */
  engineIntake = undefined as string | undefined,
} = {}) {
  const participants = [
    {
      seat: "researcher",
      role: "researcher",
      modelSelection: createModelSelection(ProviderInstanceId.make("claude-work"), "claude-model", [
        { id: "effort", value: "high" },
        { id: "contextWindow", value: "1m" },
      ]),
      ...(seatAccess ? { access: seatAccess } : {}),
    },
    {
      seat: "critic",
      role: "reviewer",
      modelSelection: createModelSelection(ProviderInstanceId.make("codex-work"), "codex-model", [
        { id: "reasoningEffort", value: "high" },
      ]),
    },
  ];
  if (third)
    participants.push({
      ...participants[0]!,
      seat: "builder",
      role: "developer",
      modelSelection: createModelSelection(
        ProviderInstanceId.make("builder-work"),
        "builder-model",
      ),
    });
  const binding = {
    team: "research",
    configuration: "research@3#abc",
    workspace: noWorkspace ? undefined : "C:/workspace",
    ...(plain
      ? {}
      : {
          orchestration: {
            participants,
            ...(critique ? { critique } : {}),
            ...(access ? { access } : {}),
          },
        }),
  };
  // What the delivery service reports as joining the next message; a test may replace it.
  const lineup = {
    current: plain
      ? undefined
      : {
          ...binding.orchestration!,
          ...(callsTeam ? { team: callsTeam } : {}),
        },
  };
  const attachedThread = threadContextRecord(
    {
      environmentId: EnvironmentId.make("reference-environment"),
      threadId: ThreadId.make("0c0750fe-1234"),
    },
    "Earlier discussion",
  );
  const message = {
    id: MessageId.make("question"),
    role: "user",
    text: `Assess the migration risk. ${formatComposerContextReference(attachedThread)}`,
    context: { records: [attachedThread] },
    attachments: [] as ChatAttachment[],
  };
  const run = {
    id: runId,
    rootNodeId: NodeId.make("root"),
    activeAttemptId: RunAttemptId.make("attempt"),
    ordinal: 1,
    status: "starting",
    userMessageId: message.id,
  };
  const tasks: Array<{
    teamChat: Delegation["teamChat"];
    title?: string;
    childThreadId?: ThreadId;
    status: string;
    result: string | null;
    providerInstanceId: ProviderInstanceId;
    model: string;
  }> = [];
  const notices: OrchestrationV2TurnItem[] = [];
  const admissions = new Map<string, Delegation>();
  const bindings: Array<{ threadId: ThreadId; team: string; role?: string; driver: string }> = [];
  const refreshed: string[] = [];
  /** The engine's native attempts, by id, as `GET /api/native-builds/:att` serves them. */
  const attempts = new Map<string, unknown>();
  const delivery = {
    read: ({ path }: { readonly path: string }) =>
      Effect.succeed({ readAt: "", body: attempts.get(path.split("/").at(-1)!) }),
    refreshThread: (_id: ThreadId, configuration: string) =>
      Effect.sync(() => {
        refreshed.push(configuration);
        binding.configuration = configuration;
        return binding;
      }),
    threadState: () =>
      Effect.succeed({
        binding: unbound ? null : binding,
        pending: null,
        ...(lineup.current ? { lineup: lineup.current } : {}),
      }),
    bindThread: (input: { threadId: ThreadId; team: string; role?: string; driver: string }) => {
      bindings.push(input);
      if (bindFailures.includes(input.role ?? ""))
        return Effect.fail(
          new DeliveryError({
            reason: "invalid",
            detail: "Engine cannot bind this role",
            ...(bindStatus === undefined ? {} : { status: bindStatus }),
          }),
        );
      return Effect.succeed({
        configuration:
          mismatchSeat === undefined || input.role === mismatchSeat
            ? participantConfiguration
            : binding.configuration,
      });
    },
  } as unknown as DeliveryService.DeliveryService["Service"];
  const projections = {
    getThreadRecords: () =>
      Effect.succeed({
        thread: {
          worktreePath: null,
          projectId: ProjectId.make("project"),
          runtimeMode: threadAccess,
          modelSelection: createModelSelection(ProviderInstanceId.make("lead-work"), "lead-model"),
          lineage:
            engineIntake !== undefined
              ? { engineIntake }
              : boardOwned
                ? { engineIntake: "task-1" }
                : {},
        },
        runs: missingRun ? [] : [run],
        messages: [message],
        subagents: tasks,
        turnItems: notices,
      }),
    getMessagesById: (_threadId: ThreadId, ids: ReadonlyArray<MessageId>) =>
      Effect.succeed(new Map(ids.includes(message.id) ? [[message.id, message]] : [])),
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
          ...(command.title === undefined ? {} : { title: command.title }),
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
    getInstance: (instanceId: ProviderInstanceId) =>
      Effect.succeed({
        enabled: !(disabled && instanceId === "codex-work") && !disabledSeats().has(instanceId),
        snapshot: {
          getSnapshot: Effect.succeed({
            installed: true,
            ...(fullAccessOnly
              ? {
                  runtimeModes: [
                    { mode: "approval-required", available: false, reason: "It cannot ask." },
                    { mode: "full-access", available: true },
                  ],
                }
              : {}),
          }),
        },
      }),
  } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
  return {
    run,
    message,
    attempts,
    tasks,
    admissions,
    notices,
    bindings,
    refreshed,
    updateConfiguration: (configuration: string) => {
      participantConfiguration = configuration;
    },
    participants,
    lineup,
    service: NativeTeamChat.make.pipe(
      Effect.provideService(ServerConfig, {
        attachmentsDir: "C:/state/attachments",
      } as unknown as ServerConfig["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        get: () =>
          noWorkspace ? Effect.succeedNone : Effect.succeedSome({ workspaceRoot: "C:/project" }),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(DeliveryService.DeliveryService, delivery),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
      Effect.provideService(EventSink.EventSinkV2, {
        writeIfRunCurrent: ({
          events,
        }: Parameters<EventSink.EventSinkV2["Service"]["writeIfRunCurrent"]>[0]) =>
          Effect.sync(() => {
            for (const event of events)
              if (event.type === "turn-item.updated") notices.push(event.payload);
            return { committed: noticeCommitted, storedEvents: [] };
          }),
      } as unknown as EventSink.EventSinkV2["Service"]),
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      Effect.provideService(ProviderAdapterRegistry.ProviderAdapterRegistryV2, adapters),
      Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, instances),
      limitFacts === undefined
        ? (effect) => effect
        : Effect.provideService(LimitedSeats.LimitedSeats, {
            facts: () => Effect.sync(limitFacts),
          }),
      Effect.provide(IdAllocator.layer),
    ),
  };
}

it.effect.each([{ bindFailures: ["researcher"] }, { bindFailures: ["researcher", "reviewer"] }])(
  "skips binding failures $bindFailures without repeating notices",
  ({ bindFailures }) =>
    Effect.gen(function* () {
      const fixture = setup({ third: true, bindFailures });
      const service = yield* fixture.service;
      const result = yield* service.prepareTurn({ threadId, runId });
      expect(result.ready).toBe(bindFailures.length === 2);
      expect(fixture.notices).toHaveLength(bindFailures.length);
      expect(fixture.notices[0]).toMatchObject({
        message: expect.stringContaining("Engine cannot bind this role"),
      });
      expect(fixture.bindings).toHaveLength(bindFailures.length === 2 ? 2 : 3);
      expect(fixture.admissions.size).toBe(bindFailures.length === 2 ? 0 : 2);
      yield* service.prepareTurn({ threadId, runId });
      expect(fixture.notices).toHaveLength(bindFailures.length);
    }),
);

it.effect.each(["workspace", "roster"] as const)(
  "falls back for missing %s only after team tasks finish",
  (problem) =>
    Effect.gen(function* () {
      const fixture = setup({ noWorkspace: problem === "workspace" });
      if (problem === "roster") fixture.participants[1]!.seat = "researcher";
      const service = yield* fixture.service;
      fixture.tasks.push({
        teamChat: { sourceRunId: runId, stage: "contribution", seat: "old" },
        status: "running",
        result: null,
        providerInstanceId: ProviderInstanceId.make("codex-work"),
        model: "codex-model",
      });
      expect((yield* service.prepareTurn({ threadId, runId })).ready).toBe(false);
      fixture.tasks[0]!.status = "completed";
      const result = yield* service.prepareTurn({ threadId, runId });
      expect(result.ready).toBe(true);
      expect(result.context).toContain("team discussion could not run");
      expect(result.context).not.toContain("hand each piece to one participant");
      expect(result.context).not.toContain("Participants:");
      expect(result.context).toContain("Independent contributions:");
      expect(result.context).toContain(problem === "workspace" ? "working folder" : "unique seats");
      expect((yield* service.prepareTurn({ threadId, runId })).context).toBe(result.context);
      expect(fixture.notices).toHaveLength(1);
      expect(fixture.admissions.size).toBe(0);
    }),
);

it.effect("fallback context does not tell a solo lead to delegate to nobody", () =>
  Effect.gen(function* () {
    const fixture = setup();
    fixture.participants.splice(1);
    const { context } = yield* (yield* fixture.service).prepareTurn({ threadId, runId });
    expect(context).not.toContain("hand each piece to one participant");
    expect(context).not.toContain("Participants:");
    expect(context).not.toContain("Independent contributions:");
  }),
);

it.effect("does not turn missing or obsolete state into a solo fallback", () =>
  Effect.gen(function* () {
    const missing = setup({ missingRun: true, noWorkspace: true });
    const missingService = yield* missing.service;
    expect((yield* missingService.prepareTurn({ threadId, runId }).pipe(Effect.flip)).reason).toBe(
      "state",
    );
    expect(missing.notices).toHaveLength(0);
    const obsolete = setup({ noWorkspace: true });
    obsolete.run.status = "interrupted";
    const obsoleteService = yield* obsolete.service;
    expect((yield* obsoleteService.prepareTurn({ threadId, runId })).ready).toBe(false);
    expect(obsolete.notices).toHaveLength(0);
  }),
);

it.effect.each([401, 403])(
  "keeps binding access refusal %s retryable without bypassing it",
  (bindStatus) =>
    Effect.gen(function* () {
      const fixture = setup({ bindFailures: ["researcher"], bindStatus });
      const service = yield* fixture.service;
      expect((yield* service.prepareTurn({ threadId, runId }).pipe(Effect.flip)).reason).toBe(
        "dispatch",
      );
      expect(fixture.admissions.size).toBe(0);
      expect(fixture.notices).toHaveLength(0);
    }),
);

it.effect("does not fall back when its notice cannot commit", () =>
  Effect.gen(function* () {
    const fixture = setup({ noWorkspace: true, noticeCommitted: false });
    const service = yield* fixture.service;
    expect((yield* service.prepareTurn({ threadId, runId }).pipe(Effect.flip)).reason).toBe(
      "state",
    );
    expect(fixture.admissions.size).toBe(0);
  }),
);

it.effect("recovers a lost dispatch receipt and shares independent results before synthesis", () =>
  Effect.gen(function* () {
    const fixture = setup({ uncertain: true });
    const service = yield* fixture.service;
    yield* service.prepareTurn({ threadId, runId }).pipe(Effect.flip);
    expect((yield* service.prepareTurn({ threadId, runId })).ready).toBe(false);
    expect(fixture.admissions.size).toBe(2);
    for (const command of fixture.admissions.values()) {
      expect(command.task).toContain("threadId: 0c0750fe-1234");
      expect(command.task).toContain(
        't3_thread_read({"threadId":"0c0750fe-1234","environmentId":"reference-environment"})',
      );
    }
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

it.effect.each(["disabled", "mismatch"] as const)(
  "skips one %s seat through both rounds and repeated preparation",
  (problem) =>
    Effect.gen(function* () {
      const fixture = setup({
        third: true,
        disabled: problem === "disabled",
        ...(problem === "mismatch"
          ? { mismatchSeat: "reviewer", participantConfiguration: "research@4#def" }
          : {}),
      });
      const service = yield* fixture.service;
      expect((yield* service.prepareTurn({ threadId, runId })).ready).toBe(false);
      const bindings = fixture.bindings.length;
      yield* service.prepareTurn({ threadId, runId });
      expect(fixture.bindings).toHaveLength(bindings);
      expect(fixture.tasks).toHaveLength(2);
      expect(fixture.notices).toHaveLength(1);
      expect(fixture.notices[0]).toMatchObject({
        type: "system_notice",
        status: "failed",
        message: expect.stringContaining(
          problem === "disabled"
            ? "critic: provider is disabled"
            : "critic: the team setup changed",
        ),
      });
      for (const task of fixture.tasks) task.status = "completed";
      expect((yield* service.prepareTurn({ threadId, runId })).ready).toBe(false);
      expect(fixture.tasks).toHaveLength(4);
      for (const task of fixture.tasks) task.status = "completed";
      const final = yield* service.prepareTurn({ threadId, runId });
      expect(final.ready).toBe(true);
      expect(final.context).toContain("critic");
      expect(final.context).toContain(problem === "disabled" ? "disabled" : "team setup changed");
      expect(final.context).toContain("Critiques:");
      expect(final.context).toContain("stop and ask");
      expect(fixture.tasks.every((task) => task.teamChat?.seat !== "critic")).toBe(true);
      yield* (yield* fixture.service).prepareTurn({ threadId, runId });
      expect(fixture.tasks).toHaveLength(4);
      expect(fixture.notices).toHaveLength(1);
    }),
);

it.effect("preserves contributions when a provider cannot join the critique round", () =>
  Effect.gen(function* () {
    const disabled = new Set<string>();
    const fixture = setup({ disabledSeats: () => disabled });
    const service = yield* fixture.service;
    expect((yield* service.prepareTurn({ threadId, runId })).ready).toBe(false);
    for (const task of fixture.tasks) {
      task.status = "completed";
      task.result = `Finding from ${task.teamChat?.seat}`;
    }
    disabled.add("codex-work");
    const result = yield* service.prepareTurn({ threadId, runId });
    expect(result.ready).toBe(true);
    expect(result.context).not.toContain("discussion did not run");
    expect(result.context).not.toContain("Answer alone");
    expect(result.context).toContain(
      "contribution round completed but the critique round could not run",
    );
    expect(result.context).toContain(
      "critic (reviewer) contributed but could not join the critique round",
    );
    expect(result.context).toContain("provider is disabled");
    expect(result.context).toContain("Synthesize their evidence");
    expect(result.context).toContain("Finding from critic");
    expect(result.context).toContain("Finding from researcher");
    expect(result.context).not.toContain("providerInstanceId codex-work");
    expect(fixture.admissions.size).toBe(2);
    expect(fixture.bindings).toHaveLength(2);
    expect((yield* service.prepareTurn({ threadId, runId })).context).toBe(result.context);
  }),
);

it.effect("does not bind a lone survivor after provider preflight", () =>
  Effect.gen(function* () {
    const fixture = setup({
      third: true,
      disabledSeats: () => new Set(["claude-work", "codex-work"]),
    });
    const result = yield* (yield* fixture.service).prepareTurn({ threadId, runId });
    expect(result.ready).toBe(true);
    expect(result.context).toContain("discussion did not run");
    expect(fixture.admissions.size).toBe(0);
    expect(fixture.notices).toHaveLength(2);
    expect(fixture.bindings).toHaveLength(0);
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

it.effect("continues the same thread when all participants use an updated team setup", () =>
  Effect.gen(function* () {
    const fixture = setup({ participantConfiguration: "research@4#def" });
    const earlier = {
      teamChat: {
        sourceRunId: RunId.make("earlier-turn"),
        stage: "contribution" as const,
        seat: "researcher",
      },
      status: "completed",
      result: "Keep this earlier finding.",
      providerInstanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-model",
    };
    fixture.tasks.push(earlier);
    const service = yield* fixture.service;
    const result = yield* service.prepareTurn({ threadId, runId });
    expect(result.ready).toBe(false);
    expect(fixture.admissions.size).toBe(2);
    expect(fixture.refreshed).toEqual(["research@4#def"]);
    expect(fixture.tasks[0]).toBe(earlier);
    for (const command of fixture.admissions.values()) {
      expect(command.parentThreadId).toBe(threadId);
    }
    yield* service.prepareTurn({ threadId, runId });
    expect(fixture.bindings).toHaveLength(2);
    expect(fixture.notices).toHaveLength(0);
    expect(fixture.admissions.size).toBe(2);
  }),
);

it.effect("keeps the setup of a discussion that has already received contributions", () =>
  Effect.gen(function* () {
    const fixture = setup({ critique: "always" });
    const service = yield* fixture.service;
    yield* service.prepareTurn({ threadId, runId });
    for (const task of fixture.tasks) {
      task.status = "completed";
      task.result = "Finding from the original setup.";
    }
    fixture.updateConfiguration("research@4#def");
    const result = yield* service.prepareTurn({ threadId, runId });
    expect(result.ready).toBe(true);
    expect(result.context).toContain("Finding from the original setup.");
    expect(result.context).toContain("next turn");
    expect(fixture.refreshed).toEqual([]);
    expect(fixture.admissions.size).toBe(2);
  }),
);

it.effect("holds participants to read-only unless the conversation gives them more", () =>
  Effect.gen(function* () {
    // Whatever the conversation's own access is, a participant asks before it changes anything.
    const readOnly = setup({ threadAccess: "full-access" });
    yield* (yield* readOnly.service).prepareTurn({ threadId, runId });
    for (const command of readOnly.admissions.values()) {
      expect(command.runtimeMode).toBe("approval-required");
      // Held by access and the reactor, not by plan mode, which makes a harness ask for approval.
      expect(command.interactionMode).toBe("default");
      expect(command.task).toContain("You are read-only here");
    }

    const chosen = setup({ access: "full-access", fullAccessOnly: true });
    yield* (yield* chosen.service).prepareTurn({ threadId, runId });
    for (const command of chosen.admissions.values()) {
      expect(command.runtimeMode).toBe("full-access");
      expect(command.interactionMode).toBe("default");
      // A round only discusses, whatever a seat's access: the orchestrator hands out the work.
      expect(command.task).toContain("change nothing here");
    }

    // A seat's own access comes before the conversation's, in either direction.
    const held = setup({ access: "full-access", seatAccess: "read-only" });
    yield* (yield* held.service).prepareTurn({ threadId, runId });
    const [researcher, critic] = [...held.admissions.values()];
    expect(researcher?.runtimeMode).toBe("approval-required");
    expect(researcher?.interactionMode).toBe("default");
    expect(researcher?.task).toContain("You are read-only here");
    expect(critic?.runtimeMode).toBe("full-access");
    expect(critic?.interactionMode).toBe("default");
    const lifted = setup({ seatAccess: "full-access", critique: "never" });
    const liftedService = yield* lifted.service;
    yield* liftedService.prepareTurn({ threadId, runId });
    const [builder, reader] = [...lifted.admissions.values()];
    expect(builder?.runtimeMode).toBe("full-access");
    expect(builder?.interactionMode).toBe("default");
    expect(reader?.interactionMode).toBe("default");
    // The orchestrator is told who may be handed work that changes things.
    for (const task of lifted.tasks) task.status = "completed";
    const handed = (yield* liftedService.prepareTurn({ threadId, runId })).context;
    expect(handed).toMatch(/- researcher \(.*may change things \(runtimeMode full-access\)/);
    expect(handed).toMatch(/- critic \(.*read-only: questions and reviews only/);

    const unheld = setup({ fullAccessOnly: true });
    const unheldError = yield* (yield* unheld.service).prepareTurn({ threadId, runId });
    expect(unheldError.context).toContain("researcher cannot be held to read-only");
    expect(unheldError.context).toContain("It cannot ask.");
    expect(unheld.admissions.size).toBe(0);

    const refused = setup({ access: "approval-required", fullAccessOnly: true });
    const error = yield* (yield* refused.service).prepareTurn({ threadId, runId });
    expect(error.context).toContain("researcher cannot join with approval-required access");
    expect(refused.admissions.size).toBe(0);
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
    const result = yield* service.prepareTurn({ threadId, runId });
    expect(result.ready).toBe(true);
    expect(result.context).toContain("discussion did not run");
    expect(result.context).toContain("critic");
    const bindings = fixture.bindings.length;
    yield* service.prepareTurn({ threadId, runId });
    expect(fixture.bindings).toHaveLength(bindings);
    expect(fixture.notices).toHaveLength(1);
    expect(fixture.admissions.size).toBe(0);
  }),
);
it.effect("joins without a team, calls one in, and survives a lineup changed mid-round", () =>
  Effect.gen(function* () {
    const alone = setup({ unbound: true });
    yield* (yield* alone.service).prepareTurn({ threadId, runId });
    expect(alone.admissions.size).toBe(2);
    expect(alone.bindings).toEqual([]);
    expect([...alone.admissions.values()][0]!.task).toContain("in this conversation");

    const called = setup({ unbound: true, callsTeam: "research" });
    yield* (yield* called.service).prepareTurn({ threadId, runId });
    expect(called.bindings.map((binding) => binding.team)).toEqual(["research", "research"]);
    expect(called.bindings.map((binding) => binding.role)).toEqual(["researcher", "reviewer"]);

    const changed = setup({ critique: "never" });
    const service = yield* changed.service;
    yield* service.prepareTurn({ threadId, runId });
    for (const task of changed.tasks) {
      task.status = "completed";
      task.result = "Finding.";
    }
    changed.lineup.current = {
      ...changed.lineup.current!,
      participants: [
        changed.participants[0]!,
        {
          seat: "custom-1",
          role: "reviewer",
          modelSelection: createModelSelection(ProviderInstanceId.make("claude-work"), "other"),
        },
      ],
    };
    expect((yield* service.prepareTurn({ threadId, runId })).ready).toBe(false);
    expect([...changed.admissions.values()].map((command) => command.teamChat?.seat)).toEqual([
      "researcher",
      "critic",
      "custom-1",
    ]);
    for (const task of changed.tasks) {
      task.status = "completed";
      task.result = "Finding.";
    }
    const final = yield* service.prepareTurn({ threadId, runId });
    expect(final.ready).toBe(true);
    expect(changed.admissions.size).toBe(3);
  }),
);

it.effect.each([
  { name: "running contributions", critique: "first", settleBeforeChange: false },
  { name: "running contributions without critique", critique: "never", settleBeforeChange: false },
  {
    name: "completed contributions with contribution-stage skips",
    critique: "first",
    settleBeforeChange: true,
  },
  { name: "running critiques", critique: "always", settleBeforeChange: false },
] as const)("waits and preserves results for $name after losing seats", (scenario) =>
  Effect.gen(function* () {
    const disabled = new Set<string>();
    const fixture = setup({
      third: true,
      disabledSeats: () => disabled,
      critique: scenario.critique,
    });
    const service = yield* fixture.service;
    expect((yield* service.prepareTurn({ threadId, runId })).ready).toBe(false);
    expect(fixture.tasks.every((task) => task.status === "running")).toBe(true);
    if (scenario.settleBeforeChange || scenario.critique === "always") {
      for (const task of fixture.tasks) {
        task.status = "completed";
        task.result = "Original contribution.";
      }
    }
    if (scenario.critique === "always") {
      expect((yield* service.prepareTurn({ threadId, runId })).ready).toBe(false);
      expect(fixture.tasks).toHaveLength(6);
    }
    disabled.add("codex-work");
    disabled.add("builder-work");
    fixture.lineup.current = {
      ...fixture.lineup.current!,
      participants: [
        fixture.participants[0]!,
        {
          seat: "custom-1",
          role: "reviewer",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex-work"), "other"),
        },
        {
          seat: "custom-2",
          role: "developer",
          modelSelection: createModelSelection(ProviderInstanceId.make("builder-work"), "other"),
        },
      ],
    };
    if (!scenario.settleBeforeChange) {
      expect(yield* service.prepareTurn({ threadId, runId })).toEqual({
        ready: false,
        context: "",
      });
      for (const task of fixture.tasks.slice(0, -1)) {
        task.status = "completed";
        task.result = "Preserved result.";
      }
      expect((yield* service.prepareTurn({ threadId, runId })).ready).toBe(false);
    }
    for (const task of fixture.tasks) {
      task.status = "completed";
      task.result = "Preserved result.";
    }
    const final = yield* service.prepareTurn({ threadId, runId });
    expect(final.ready).toBe(true);
    expect(final.context).toContain("Preserved result.");
    expect(final.context).toContain(
      "discussion stopped after the contributions below because fewer than two seats could continue",
    );
    expect(final.context).not.toContain("critique round could not run");
    expect(final.context).not.toContain("No contribution was returned");
    expect(final.context).not.toContain("custom-1 (reviewer) contributed");
    if (scenario.critique === "always") expect(final.context).toContain("Critiques:");
    expect(fixture.tasks).toHaveLength(scenario.critique === "always" ? 6 : 3);
  }),
);

it.effect(
  "does not send compaction controls to the roster, and passes attachments as paths to read",
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
      yield* service.prepareTurn({ threadId, runId });
      expect(fixture.admissions.size).toBe(2);
      for (const command of fixture.admissions.values()) {
        expect(command.task).toContain("- diagram.png: ");
        expect(command.task.replaceAll("\\", "/")).toContain("C:/state/attachments/image.png");
      }
    }),
);

const LIMIT_RESET = "2026-11-22T17:00:00.000Z";
const RESET_SHOWN = NativeTeamChat.formatLimitReset(LIMIT_RESET);
const MODEL_NAMES = { "claude-model": "Claude Model", "kimi-k3": "Kimi K3" };
const limitedProvider = (instanceId: string, driver: string, limited = false): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-22T11:00:00.000Z",
  // Named as the model picker names them; the notes use these names, not the ids.
  models: Object.entries(MODEL_NAMES).map(([slug, name]) => ({
    slug,
    name,
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
  ...(limited
    ? {
        usageLimits: {
          checkedAt: "2026-11-22T11:00:00.000Z",
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "5 hours",
              usedPercent: 100,
              resetsAt: LIMIT_RESET,
            },
          ],
        },
      }
    : {}),
});

/** The researcher's Claude is limited; Favorites are Kimi, then DeepSeek. */
function limitedResearcher(
  options: Omit<NonNullable<Parameters<typeof setup>[0]>, "limitFacts"> & {
    readonly favorites?: ReadonlyArray<readonly [string, string]>;
  } = {},
) {
  const limitedInstances = new Set(["claude-work"]);
  const providers = [
    ["claude-work", "claudeAgent"],
    ["codex-work", "codex"],
    ["builder-work", "codex"],
    ["kimi-work", "kimi"],
    ["deepseek-work", "deepseek"],
  ] as const;
  const { favorites, ...rest } = options;
  const fixture = setup({
    third: true,
    ...rest,
    limitFacts: () => ({
      now: Date.parse("2026-11-22T12:00:00.000Z"),
      projectId: ProjectId.make("project"),
      threadLimits: [],
      providers: providers.map(([instanceId, driver]) =>
        limitedProvider(instanceId, driver, limitedInstances.has(instanceId)),
      ),
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: Object.fromEntries(
          providers.map(([instanceId, driver]) => [
            ProviderInstanceId.make(instanceId),
            { driver: ProviderDriverKind.make(driver), enabled: true },
          ]),
        ),
        favorites: (
          favorites ?? [
            ["kimi-work", "kimi-k3"],
            ["deepseek-work", "deepseek-v4"],
          ]
        ).map(([provider, model]) => ({ provider: ProviderInstanceId.make(provider), model })),
      },
    }),
  });
  const seatsOn = () =>
    Object.fromEntries(
      [...fixture.admissions.values()].map((command) => [
        `${command.teamChat.stage}:${command.teamChat.seat}`,
        command.modelSelection.model,
      ]),
    );
  return { ...fixture, limitedInstances, seatsOn };
}

it.effect("starts a limited seat on the first free favorite and notes why", () =>
  Effect.gen(function* () {
    const fixture = limitedResearcher();
    const service = yield* fixture.service;
    yield* service.prepareTurn({ threadId, runId });
    // Swap automatically is the default: the lineup states no setting.
    expect(fixture.lineup.current).not.toHaveProperty("limitedSeat");
    expect(fixture.seatsOn()).toEqual({
      "contribution:researcher": "kimi-k3",
      "contribution:critic": "codex-model",
      "contribution:builder": "builder-model",
    });
    const researcher = [...fixture.admissions.values()].find(
      (command) => command.teamChat.seat === "researcher",
    )!;
    expect(researcher.modelSelection.instanceId).toBe("kimi-work");
    expect(researcher.teamChat.substituteFor).toEqual({
      instanceId: "claude-work",
      model: "claude-model",
      resetAt: LIMIT_RESET,
    });
    expect(fixture.notices).toHaveLength(1);
    expect(fixture.notices[0]).toMatchObject({
      status: "completed",
      title: "researcher · substitute",
      message: `researcher runs on Kimi K3 this turn: Claude Model has reached its usage limit until ${RESET_SHOWN}.`,
    });
    // Whoever reads the researcher's contribution is told which model stood in for it.
    for (const task of fixture.tasks)
      Object.assign(task, { status: "completed", result: "Noted." });
    yield* service.prepareTurn({ threadId, runId });
    const critique = [...fixture.admissions.values()].find(
      (command) => command.teamChat.stage === "critique",
    )!;
    expect(critique.task).toContain(
      "kimi-work/kimi-k3, standing in for claude-model, which reached its usage limit, completed",
    );
  }),
);

it.effect(
  "swaps a seat once a turn: the critique keeps the stand-in or sits out, never a third model",
  () =>
    Effect.gen(function* () {
      const fixture = limitedResearcher({ critique: "always" });
      const service = yield* fixture.service;
      yield* service.prepareTurn({ threadId, runId });
      for (const task of fixture.tasks) task.status = "completed";
      // The stand-in reaches its own limit before the critique round.
      fixture.limitedInstances.add("kimi-work");
      yield* service.prepareTurn({ threadId, runId });
      expect(fixture.seatsOn()).toEqual({
        "contribution:researcher": "kimi-k3",
        "contribution:critic": "codex-model",
        "contribution:builder": "builder-model",
        "critique:critic": "codex-model",
        "critique:builder": "builder-model",
      });
      expect(fixture.notices.at(-1)).toMatchObject({
        status: "failed",
        message: expect.stringContaining("a seat is swapped once a turn"),
      });
    }),
);

it.effect("keeps the same stand-in for the critique round while it stays free", () =>
  Effect.gen(function* () {
    const fixture = limitedResearcher({ critique: "always" });
    const service = yield* fixture.service;
    yield* service.prepareTurn({ threadId, runId });
    for (const task of fixture.tasks) task.status = "completed";
    yield* service.prepareTurn({ threadId, runId });
    expect(fixture.seatsOn()["critique:researcher"]).toBe("kimi-k3");
  }),
);

it.effect("leaves a limited seat waiting with a notice when no favorite is free", () =>
  Effect.gen(function* () {
    // The only favorites are the limited account's own model and a provider that is not there.
    const fixture = limitedResearcher({
      favorites: [
        ["claude-work", "claude-other"],
        ["lead-work", "lead-model"],
      ],
    });
    const service = yield* fixture.service;
    yield* service.prepareTurn({ threadId, runId });
    expect(Object.keys(fixture.seatsOn())).toEqual(["contribution:critic", "contribution:builder"]);
    expect(fixture.notices).toHaveLength(1);
    expect(fixture.notices[0]).toMatchObject({
      status: "failed",
      title: "researcher · skipped",
      message: expect.stringContaining("No favorite model is free, so researcher waits."),
    });
  }),
);

it.effect("does not swap a model a person chose by hand; the notice still names the free one", () =>
  Effect.gen(function* () {
    const fixture = limitedResearcher();
    Object.assign(fixture.participants[0]!, { picked: true });
    const service = yield* fixture.service;
    yield* service.prepareTurn({ threadId, runId });
    expect(fixture.seatsOn()).not.toHaveProperty("contribution:researcher");
    expect(fixture.notices[0]?.type === "system_notice" && fixture.notices[0].message).toBe(
      `researcher: Claude Model has reached its usage limit until ${RESET_SHOWN}. Its model was chosen by hand, so it is not swapped without asking. Kimi K3 is free: swap to it from the notice to use it from the next message.`,
    );
  }),
);

it.effect("asks before a swap, and uses the model the person agreed to", () =>
  Effect.gen(function* () {
    const fixture = limitedResearcher();
    fixture.lineup.current = { ...fixture.lineup.current!, limitedSeat: "ask" } as never;
    const service = yield* fixture.service;
    yield* service.prepareTurn({ threadId, runId });
    expect(fixture.seatsOn()).not.toHaveProperty("contribution:researcher");
    expect(fixture.notices[0]).toMatchObject({
      message: expect.stringContaining("Kimi K3 is free: swap to it from the notice"),
    });

    const agreed = limitedResearcher();
    Object.assign(agreed.participants[0]!, {
      substitute: createModelSelection(ProviderInstanceId.make("deepseek-work"), "deepseek-v4"),
    });
    agreed.lineup.current = { ...agreed.lineup.current!, limitedSeat: "ask" } as never;
    yield* (yield* agreed.service).prepareTurn({ threadId, runId });
    expect(agreed.seatsOn()["contribution:researcher"]).toBe("deepseek-v4");
  }),
);

it.effect("leaves another seat's agreed substitute to that seat", () =>
  Effect.gen(function* () {
    const fixture = limitedResearcher();
    fixture.limitedInstances.add("codex-work");
    // The critic comes after the researcher in the roster, and already agreed to Kimi.
    Object.assign(fixture.participants[1]!, {
      substitute: createModelSelection(ProviderInstanceId.make("kimi-work"), "kimi-k3"),
    });
    fixture.lineup.current = { ...fixture.lineup.current!, limitedSeat: "ask" } as never;
    yield* (yield* fixture.service).prepareTurn({ threadId, runId });
    expect(fixture.seatsOn()["contribution:critic"]).toBe("kimi-k3");
    expect(fixture.seatsOn()).not.toHaveProperty("contribution:researcher");
    expect(fixture.notices[0]).toMatchObject({
      message: expect.stringContaining("deepseek-v4 is free: swap to it from the notice"),
    });
  }),
);

it.effect(
  "reads the setting at the start of each turn, so a change applies from the next message",
  () =>
    Effect.gen(function* () {
      const fixture = limitedResearcher();
      const service = yield* fixture.service;
      yield* service.prepareTurn({ threadId, runId });
      expect(fixture.seatsOn()["contribution:researcher"]).toBe("kimi-k3");
      // The person chooses Leave it out; the next message is a new turn with nothing recorded.
      fixture.lineup.current = { ...fixture.lineup.current!, limitedSeat: "skip" } as never;
      fixture.tasks.length = 0;
      fixture.notices.length = 0;
      fixture.admissions.clear();
      yield* service.prepareTurn({ threadId, runId });
      expect(fixture.seatsOn()).not.toHaveProperty("contribution:researcher");
      expect(fixture.notices[0]).toMatchObject({
        message: `researcher: Claude Model has reached its usage limit until ${RESET_SHOWN}. Left out of this message.`,
      });
    }),
);

it.effect("leaves a board task's conversation to its team's own setting", () =>
  Effect.gen(function* () {
    const fixture = limitedResearcher({ boardOwned: true });
    yield* (yield* fixture.service).prepareTurn({ threadId, runId });
    expect(fixture.seatsOn()["contribution:researcher"]).toBe("claude-model");
    expect(fixture.notices).toHaveLength(0);
  }),
);

it.effect("starts no team round for an engine notice, nor in a board task's conversation", () =>
  Effect.gen(function* () {
    const idle = { ready: true, context: "" };
    const notice = setup();
    Object.assign(notice.message, {
      notification: engineNotice("A steer from the board", "Use the other API"),
    });
    expect(yield* (yield* notice.service).prepareTurn({ threadId, runId })).toEqual(idle);
    expect(notice.admissions.size).toBe(0);
    // While the engine's runners do a board task's work, a person's message goes to the lead alone.
    const task = setup({ engineIntake: boardTaskThreadMarker(boardTaskOf("work", "task-7")!) });
    expect(yield* (yield* task.service).prepareTurn({ threadId, runId })).toEqual(idle);
    expect(task.admissions.size).toBe(0);
    expect(task.notices).toHaveLength(0);
  }),
);

it.effect("runs the team round for the engine's brief in a board task's conversation", () =>
  Effect.gen(function* () {
    const brief = setup({ engineIntake: boardTaskThreadMarker(boardTaskOf("work", "task-7")!) });
    Object.assign(brief.message, { id: briefMessageId("att-plan") });
    brief.run.userMessageId = brief.message.id;
    expect((yield* (yield* brief.service).prepareTurn({ threadId, runId })).ready).toBe(false);
    expect([...brief.admissions.values()].map((command) => command.teamChat?.seat)).toEqual([
      "researcher",
      "critic",
    ]);
  }),
);

it.effect("starts an engine stage's seats as children of its turn, with or without a team", () =>
  Effect.gen(function* () {
    // A task whose team has no seat but its lead's here has no lineup: its seats start all the same.
    const board = boardTaskThreadId(boardTaskOf("work", "task-7")!);
    const fixture = setup({
      engineIntake: boardTaskThreadMarker(boardTaskOf("work", "task-7")!),
      plain: true,
    });
    const seat = {
      attemptId: "att-qa",
      seat: "qa",
      childThreadId: ThreadId.make("child-qa"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex-work"), "codex-model"),
      access: "read-only" as const,
      worktreePath: "/work/qa-1",
    };
    Object.assign(fixture.message, {
      id: stageMessageId("att-qa"),
      notification: engineStageNotice("qa", [
        seat,
        { ...seat, attemptId: "att-stopped", seat: "qa-2", childThreadId: ThreadId.make("c-2") },
      ]),
    });
    fixture.run.userMessageId = fixture.message.id;
    fixture.attempts.set("att-qa", {
      version: 2,
      id: "att-qa",
      run: "run-1",
      task: "task-7",
      stage: "qa",
      kind: "qa",
      seat: "qa",
      lead: false,
      access: "read-only",
      worktree: "/work/qa-1",
      harness: "codex",
      model: "codex-model",
      prompt: "Test the candidate.",
      state: "claimed",
      owner: "t3-board:here",
      native: null,
      cancelRequested: false,
    });
    // The engine stopped this seat, or T3 already reported it: it is read again, and never started.
    fixture.attempts.set("att-stopped", {
      ...(fixture.attempts.get("att-qa") as object),
      id: "att-stopped",
      seat: "qa-2",
      state: "cancelled",
      cancelRequested: true,
    });
    const service = yield* fixture.service;
    expect(yield* service.prepareTurn({ threadId: board, runId })).toEqual({
      ready: false,
      context: "",
    });
    const [started] = [...fixture.admissions.values()];
    expect(started).toMatchObject({
      commandId: seatCommandId(board, "att-qa"),
      parentRunId: runId,
      title: "qa · qa",
      task: "Test the candidate.",
      modelSelection: seat.modelSelection,
      runtimeMode: "approval-required",
      workspaceStrategy: { type: "existing_worktree", worktreePath: "/work/qa-1" },
      completionWake: "settled_only",
    });
    // Not a team discussion: no critique round, and no follow-up for a later one.
    expect(started?.teamChat).toBeUndefined();
    fixture.tasks[0]!.childThreadId = seat.childThreadId;
    expect((yield* service.prepareTurn({ threadId: board, runId })).ready).toBe(false);
    expect(fixture.admissions.size).toBe(1);
    Object.assign(fixture.tasks[0]!, { status: "completed", result: "All items pass." });
    const done = yield* service.prepareTurn({ threadId: board, runId });
    expect(done.ready).toBe(true);
    expect(done.context).toContain("qa · qa (codex-work/codex-model, completed");
    expect(done.context).toContain("All items pass.");
    expect(fixture.admissions.size).toBe(1);
  }),
);
