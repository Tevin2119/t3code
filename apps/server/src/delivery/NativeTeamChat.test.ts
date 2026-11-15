import {
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
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { createModelSelection } from "@t3tools/shared/model";
import { ServerConfig } from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as DeliveryService from "./DeliveryService.ts";
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
  const message = {
    id: MessageId.make("question"),
    role: "user",
    text: "Assess the migration risk.",
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
    status: string;
    result: string | null;
    providerInstanceId: ProviderInstanceId;
    model: string;
  }> = [];
  const notices: OrchestrationV2TurnItem[] = [];
  const admissions = new Map<string, Delegation>();
  const bindings: Array<{ threadId: ThreadId; team: string; role?: string; driver: string }> = [];
  const delivery = {
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
        },
        runs: missingRun ? [] : [run],
        messages: [message],
        subagents: tasks,
        turnItems: notices,
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
    tasks,
    admissions,
    notices,
    bindings,
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
      expect(result.context).toContain(problem === "workspace" ? "working folder" : "unique seats");
      expect((yield* service.prepareTurn({ threadId, runId })).context).toBe(result.context);
      expect(fixture.notices).toHaveLength(1);
      expect(fixture.admissions.size).toBe(0);
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

it.effect.each([401, 403])("does not bypass binding access refusal %s", (bindStatus) =>
  Effect.gen(function* () {
    const fixture = setup({ bindFailures: ["researcher"], bindStatus });
    const service = yield* fixture.service;
    expect((yield* service.prepareTurn({ threadId, runId }).pipe(Effect.flip)).reason).toBe(
      "state",
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

it.effect("explains a participant revision mismatch without dispatching the team", () =>
  Effect.gen(function* () {
    const fixture = setup({ participantConfiguration: "research@4#def" });
    const service = yield* fixture.service;
    const result = yield* service.prepareTurn({ threadId, runId });
    expect(result.ready).toBe(true);
    expect(result.context).toContain("discussion did not run");
    expect(result.context).toContain("researcher");
    expect(result.context).toContain("research@3#abc");
    expect(result.context).toContain("research@4#def");
    expect(result.context).toContain("new team conversation");
    yield* service.prepareTurn({ threadId, runId });
    expect(fixture.bindings).toHaveLength(1);
    expect(fixture.notices).toHaveLength(1);
    expect(fixture.admissions.size).toBe(0);
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
