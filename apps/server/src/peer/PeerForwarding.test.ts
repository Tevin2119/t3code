import * as BoardThreadTasks from "../delivery/BoardThreadTasks.ts";
import * as DeliveryService from "../delivery/DeliveryService.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DeliveryError,
  EnvironmentId,
  type LinkedDeliveryAction,
  LINKED_HANDOFF_BUNDLE_MAX_BYTES,
  LINKED_HANDOFF_MCP_MAX_BYTES,
  LinkedHandoffPeerResponses,
  linkedHandoffPeerResult,
  type PeerLink,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type SourceControlCloneRepositoryInput,
  ProjectId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import type { ProjectionTimelinePageOptions } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RemoteDelegation from "./RemoteDelegation.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerLinkRequests from "./PeerLinkRequests.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

it.effect.each([
  "owner",
  "peer",
  "linked-work",
  "unpaired",
  "links-off",
  "linked",
  "offline",
  "unauthorized",
  "environment-mismatch",
  "old",
  "read-only",
] as const)("linked delivery separates caller scope and reports %s", (mode) => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const callerId = ThreadId.make("ordinary");
  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId: local,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
    requestNamespace: "fixture",
    client:
      mode === "peer"
        ? { sessionId: "fixture", label: "Other", access: "full-access", linked: true }
        : undefined,
    linkedEnvironments: mode !== "links-off",
    thread:
      mode === "peer"
        ? undefined
        : {
            threadId: callerId,
            providerSessionId: "fixture",
            providerInstanceId: ProviderInstanceId.make("pi"),
          },
  };
  const calls: string[] = [];
  const boards = [
    {
      id: "work",
      title: "Shared",
      icon: null,
      description: "",
      counts: { tasks: 0, waitingOnYou: 0, questions: 0 },
    },
  ];
  return Effect.gen(function* () {
    const forwarding = yield* PeerForwarding.PeerForwarding;
    const input = { folder: "/workspace/repo", board: "work" };
    if (mode === "owner" || mode === "peer") {
      const result = yield* forwarding.readDelivery(scope, input);
      expect(result.diagnostics).toEqual([mode === "owner" ? "disabled" : "unauthorized"]);
      expect(calls).toEqual([]);
      return;
    }
    const target = { peerEnvironmentId: remote };
    const result = yield* forwarding.readLinkedAsAgent(scope, target, { operation: "boards" });
    expect(result.diagnostic).toBe(
      mode === "links-off" || mode === "unpaired"
        ? "not-linked"
        : mode === "linked-work"
          ? "unauthorized"
          : mode === "old"
            ? "unsupported"
            : mode === "linked" || mode === "read-only"
              ? null
              : mode,
    );
    expect(JSON.stringify(result)).not.toContain("private-fixture");
    if (mode === "read-only") {
      const actions = [
        { operation: "comment", taskId: "task", text: "hello" },
        { operation: "answer", taskId: "task", replyTo: 1, answer: { option: "first" } },
        { operation: "control", taskId: "task", action: "pause" },
        { operation: "steer", taskId: "task", text: "continue" },
        { operation: "take", taskId: "task", origin: "conversation" },
        { operation: "renew", taskId: "task", holder: "lease" },
        { operation: "release", taskId: "task", holder: "lease" },
      ] satisfies ReadonlyArray<LinkedDeliveryAction>;
      for (const action of actions) {
        expect((yield* forwarding.linkedDelivery(target, action)).diagnostic).toBe("read-only");
      }
      expect(calls).toEqual(["delivery_linked_read"]);
    }
    if (mode === "linked") {
      const legacy = yield* forwarding.readDelivery(scope, input, remote);
      expect(legacy.boards).toEqual([{ id: "work", branch: null }]);
      expect(calls).toEqual(["delivery_linked_read"]);
      expect((yield* forwarding.listLinkedBoards({})).links).toMatchObject([
        { environmentId: remote, label: "Remote", data: { boards } },
      ]);
      expect(calls).toEqual(["delivery_linked_read"]);
      yield* forwarding.linkedDelivery({ ...target, fresh: true }, { operation: "boards" });
      expect(calls).toHaveLength(2);
      yield* TestClock.adjust("5 seconds");
      yield* forwarding.linkedDelivery(target, { operation: "boards" });
      expect(calls).toHaveLength(3);
    }
  }).pipe(
    Effect.provide([
      PeerForwarding.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            Layer.mock(PeerLinks.PeerLinks)({
              enabled: Effect.succeed(true),
              get: () =>
                Effect.gen(function* () {
                  if (mode === "unpaired") return Option.none();
                  const now = yield* DateTime.now;
                  return Option.some({
                    environmentId: remote,
                    label: "Remote",
                    urls: ["http://test.invalid"],
                    access: mode === "read-only" ? "read-only" : "full-access",
                    linkedAt: DateTime.makeUnsafe(0),
                    expiresAt: DateTime.add(now, { hours: 1 }),
                    lastReachedAt: null,
                    lastError: null,
                  } satisfies PeerLink);
                }),
              listStored: Effect.succeed([
                {
                  environmentId: remote,
                  label: "Remote",
                  access: "full-access",
                  urls: ["http://test.invalid"],
                  linkedAt: DateTime.makeUnsafe(0),
                  expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
                  lastReachedAt: null,
                  lastError: null,
                },
              ]),
            }),
            Layer.mock(PeerMcpClient.PeerMcpClient)({
              call: (request) => {
                calls.push(request.tool);
                expect(request.arguments).toEqual({ request: { operation: "boards" } });
                if (mode === "old" || mode === "unauthorized" || mode === "offline") {
                  return Effect.fail(
                    new OrchestratorMcpFailure({
                      code:
                        mode === "old"
                          ? "invalid_request"
                          : mode === "unauthorized"
                            ? "capability_denied"
                            : "orchestration_error",
                      message: "Bearer private-fixture",
                    }),
                  );
                }
                return Effect.succeed({
                  environmentId: mode === "environment-mismatch" ? local : remote,
                  diagnostic: null,
                  data: { boards },
                } as never);
              },
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed({
                  ...liveThreadShell(callerId),
                  ...(mode === "linked-work"
                    ? {
                        linkOrigin: {
                          sessionId: "other",
                          label: "Other",
                          access: "full-access" as const,
                        },
                      }
                    : {}),
                }),
            }),
          ),
        ),
      ),
      DeliveryService.layerTest,
    ]),
  );
});

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const boxProject = ProjectId.make("project:box");
const boxThread = ThreadId.make("thread:box-auto");
const boxRun = RunId.make("run:box-auto");

/** What B's thread service was asked to do. */
interface Seen {
  readonly sends: ReadonlyArray<ThreadManagement.ThreadManagementSendInput>;
  readonly waits: ReadonlyArray<ThreadManagement.ThreadManagementWaitInput>;
  readonly reads: ReadonlyArray<ProjectionTimelinePageOptions>;
  readonly launches: ReadonlyArray<ThreadLaunch.ThreadLaunchInput>;
  readonly projects: ReadonlyArray<ProjectService.ProjectCreateInput>;
  readonly clones: ReadonlyArray<SourceControlCloneRepositoryInput>;
  /** Commands dispatched and delegated-task stops, as `<type> <threadId>`. */
  readonly stops: ReadonlyArray<string>;
}
const nothingSeen: Seen = {
  sends: [],
  waits: [],
  reads: [],
  launches: [],
  projects: [],
  clones: [],
  stops: [],
};

/** The box user's own thread, which no link started. */
const usersThread = ThreadId.make("thread:box-users-own");

/**
 * B's threads: one `auto` thread in `boxProject` that the laptop's link
 * started, whose run finishes on the third wait, and the box user's own.
 * Every send and wait is recorded.
 */
const boxThreads = (seen: Ref.Ref<Seen>, linkSession: Ref.Ref<string>, taskThread: boolean) => {
  const base = { ...liveThreadShell(boxThread, { runtimeMode: "auto" }), projectId: boxProject };
  const linked = Ref.get(linkSession).pipe(
    Effect.map((sessionId) => ({
      ...base,
      linkOrigin: { sessionId, label: "T3 Code · Laptop" },
      lineage: taskThread
        ? { ...base.lineage, engineIntake: "board-task:work:task-demo" }
        : base.lineage,
    })),
  );
  const users = { ...liveThreadShell(usersThread, { runtimeMode: "auto" }), projectId: boxProject };
  const run = (status: OrchestrationV2Run["status"]) =>
    ({
      id: boxRun,
      ordinal: 1,
      status,
      modelSelection: base.modelSelection,
      requestedAt: base.createdAt,
      startedAt: null,
      completedAt: null,
    }) as unknown as OrchestrationV2Run;
  const shellOf = (threadId: ThreadId): Effect.Effect<OrchestrationV2ThreadShell | null> =>
    threadId === boxThread ? linked : Effect.succeed(threadId === usersThread ? users : null);
  const projectionOf = (threadId: ThreadId) =>
    shellOf(threadId).pipe(
      Effect.map(
        (thread) =>
          ({ thread, runs: [run("running")], runtimeRequests: [], providerTurns: [] }) as never,
      ),
    );
  return Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: shellOf,
    getProjectThreadRecords: (input) => projectionOf(input.threadId),
    getThreadRecords: (threadId) => projectionOf(threadId),
    getRunCount: () => Effect.succeed(1),
    getTimelinePage: (_threadId, options) =>
      Ref.update(seen, (current) => ({ ...current, reads: [...current.reads, options] })).pipe(
        Effect.as({ items: [], totalItems: 0, hasMore: false, hasEarlier: false }),
      ),
    listProjectThreads: () => linked.pipe(Effect.map((shell) => [shell] as never)),
    getShellSnapshot: () => linked.pipe(Effect.map((shell) => ({ threads: [shell] }) as never)),
    sendToThread: (input) =>
      Ref.update(seen, (current) => ({ ...current, sends: [...current.sends, input] })).pipe(
        Effect.as({ run: run("running"), delivery: "started" } as never),
      ),
    dispatch: (command) =>
      Ref.update(seen, (current) => ({
        ...current,
        stops: [
          ...current.stops,
          `${command.type} ${"threadId" in command ? command.threadId : ""}`,
        ],
      })).pipe(
        // The stop asks the provider to interrupt the thread's running turn.
        Effect.as({
          sequence: 0,
          storedEvents: [
            {
              sequence: 1,
              commandId: command.commandId,
              event: {
                type: "turn-item.updated",
                runId: boxRun,
                payload: {
                  type: "run_interrupt_request",
                  providerTurnId: "provider-turn:box-auto",
                },
              },
            },
          ],
        } as never),
      ),
    stopDelegatedTasks: (input) =>
      Ref.update(seen, (current) => ({
        ...current,
        stops: [...current.stops, `delegated-tasks.stop ${input.threadId}`],
      })),
    waitForThread: (input) =>
      Ref.update(seen, (current) => ({ ...current, waits: [...current.waits, input] })).pipe(
        Effect.as({ threadId: input.threadId, run: run("completed"), timedOut: false }),
      ),
  });
};

/** B launches whatever it is asked to, and records it. */
const boxLaunches = (seen: Ref.Ref<Seen>) =>
  Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Ref.update(seen, (current) => ({ ...current, launches: [...current.launches, input] })).pipe(
        Effect.as({
          threadId: input.threadId,
          projection: {
            thread: {
              id: input.threadId,
              projectId: input.projectId,
              modelSelection: input.modelSelection,
              title: input.title,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult),
      ),
  });

/** B clones and registers whatever it is asked to, and records it. */
const boxProjects = (seen: Ref.Ref<Seen>) =>
  Layer.merge(
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === boxProject
            ? Option.some({
                id,
                title: "t3code",
                workspaceRoot: "/box/t3code",
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-10-18T00:00:00.000Z",
                updatedAt: "2026-10-18T00:00:00.000Z",
                deletedAt: null,
              })
            : Option.none(),
        ),
      create: (input) =>
        Ref.update(seen, (current) => ({
          ...current,
          projects: [...current.projects, input],
        })).pipe(
          Effect.as({
            id: input.projectId,
            title: input.title,
            workspaceRoot: input.workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-18T00:00:00.000Z",
            updatedAt: "2026-10-18T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
      cloneRepository: (input) =>
        Ref.update(seen, (current) => ({ ...current, clones: [...current.clones, input] })).pipe(
          Effect.as({
            cwd: input.destinationPath,
            remoteUrl: "https://github.com/pingdotgg/t3code.git",
            repository: null,
          }),
        ),
    }),
  );

/**
 * The orchestrator and project toolkits on B's real `/mcp`, behind its real
 * OAuth. `linkSession` is filled in once A links, so B's fixture thread reads
 * as one that link started.
 */
const serveBox = (
  seen: Ref.Ref<Seen>,
  linkSession: Ref.Ref<string>,
  taskDelivery?: Layer.Layer<DeliveryService.DeliveryService>,
) =>
  servePeer(
    box,
    Layer.mergeAll(
      McpHttpServer.layerOrchestratorToolkit.pipe(
        Layer.provide(Layer.mock(BoardThreadTasks.BoardThreadTasks)({})),
      ),
      McpHttpServer.layerLinkedDeliveryToolkit,
      McpHttpServer.layerProjectRegistration,
      McpHttpServer.layerThreadToolkit,
    ).pipe(
      Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Layer.provide(
        PeerForwarding.layer.pipe(Layer.provide(Layer.mock(PeerMcpClient.PeerMcpClient)({}))),
      ),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(
        Layer.merge(
          boxThreads(seen, linkSession, taskDelivery !== undefined),
          taskDelivery ?? DeliveryService.layerTest,
        ),
      ),
      Layer.provide(
        Layer.mock(ThreadSearch.ThreadSearch)({
          searchThreads: () =>
            Effect.succeed({
              matches: [
                {
                  threadId: boxThread,
                  projectId: boxProject,
                  title: "Task transcript",
                  source: "title",
                },
              ],
            }),
        }),
      ),
      Layer.provide(boxLaunches(seen)),
      Layer.provide(
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(boxProjects(seen)),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-forwarding-box-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      ),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
      Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
      Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    ),
  );

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "peer-forwarding-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "peer-forwarding-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/**
 * Environment A: its own orchestrator toolkit with forwarding, and a thread
 * caller whose modes the test picks. Its local threads never matter here.
 */
const makeLaptop = Effect.gen(function* () {
  const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
  const layerHere = Layer.mergeAll(
    McpHttpServer.layerLinkedDeliveryToolkit.pipe(Layer.provide(DeliveryService.layerTest)),
    McpHttpServer.layerOrchestratorToolkit.pipe(
      Layer.provide(Layer.mock(BoardThreadTasks.BoardThreadTasks)({})),
      Layer.provide(DeliveryService.layerTest),
    ),
    McpHttpServer.layerProjectRegistration,
    McpHttpServer.layerThreadToolkit,
  ).pipe(
    Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-forwarding-laptop-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(PeerForwarding.layer),
    Layer.provide(Layer.succeedContext(linking)),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(
            threadId === ThreadId.make("thread:laptop-from-desk")
              ? {
                  ...liveThreadShell(threadId, { runtimeMode: "full-access" }),
                  // Work another environment's link started on this laptop.
                  linkOrigin: { sessionId: "session:desk", label: "T3 Code · Desk" },
                }
              : liveThreadShell(
                  threadId,
                  threadId === ThreadId.make("thread:laptop-plan")
                    ? { runtimeMode: "full-access", interactionMode: "plan" }
                    : { runtimeMode: "full-access" },
                ),
          ),
        getProjectThreadRecords: ({ threadId }) =>
          Effect.succeed({
            thread: liveThreadShell(threadId, { runtimeMode: "full-access" }),
          } as never),
      }),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        ServerSettings.layerTest(),
        // No thread here delegated to the box, so a send there is no follow-up.
        Layer.mock(RemoteDelegation.RemoteDelegation)({
          followUp: (_scope, _environmentId, _request, sent) => Effect.succeed(sent),
        }),
        Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
      ),
    ),
    Layer.fresh,
  );
  const here = yield* Layer.build(layerHere);
  const server = Context.get(here, McpServer.McpServer);
  const scopeOf = (
    caller: string,
    capabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set(["orchestration"]),
  ): McpInvocationContext.McpInvocationScope => ({
    environmentId: laptop.environmentId,
    requestNamespace: `provider-session:${caller}`,
    thread: {
      threadId: ThreadId.make(caller),
      providerSessionId: `provider-session:${caller}`,
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities,
    issuedAt: 1,
  });
  const call = (
    caller: string,
    name: string,
    args: Record<string, unknown>,
    capabilities?: ReadonlySet<McpInvocationContext.McpCapability>,
  ) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          scopeOf(caller, capabilities),
        ),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  const callAsClient = (name: string, args: Record<string, unknown>) =>
    server.callTool({ name, arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...scopeOf("outside-client"),
        requestNamespace: "client:session-1",
        thread: undefined,
        client: { sessionId: "session-1", label: "claude.ai", access: "read-only" },
      }),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
    );
  return {
    links: Context.get(linking, PeerLinks.PeerLinks),
    peer: Context.get(linking, PeerMcpClient.PeerMcpClient),
    call,
    callAsClient,
  };
});

const failureOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

it.effect("uses the owner engine's visibility for linked thread snapshots, lists and search", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const visibility = yield* Ref.make<"private" | "shared" | "offline">("private");
      const unavailable = new DeliveryError({
        reason: "unreachable",
        detail: "Fixture engine offline.",
      });
      const taskDelivery = Layer.effect(
        DeliveryService.DeliveryService,
        Effect.map(DeliveryService.DeliveryService, (service) => ({
          ...service,
          readLinked: () =>
            Effect.succeed({
              boards: [
                {
                  id: "work",
                  title: "Shared board",
                  icon: null,
                  description: "",
                  counts: { tasks: 1, questions: 0, waitingOnYou: 0 },
                },
              ],
            } as never),
          ownerTiedThreads: () =>
            Ref.get(visibility).pipe(
              Effect.flatMap((value) =>
                value === "offline"
                  ? Effect.fail(unavailable)
                  : Effect.succeed({ ties: new Map([[boxThread, value === "shared"]]) }),
              ),
            ),
        })),
      ).pipe(Layer.provide(DeliveryService.layerTest));
      const b = yield* serveBox(seen, linkSession, taskDelivery);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);
      const linkedBoards = yield* a.call("thread:laptop-full", "delivery_read_linked", {
        peerEnvironmentId: box.environmentId,
        request: { operation: "boards" },
      });
      expect(linkedBoards.structuredContent).toMatchObject({
        environmentId: box.environmentId,
        diagnostic: null,
        data: { boards: [{ id: "work" }] },
      });
      for (const state of ["private", "shared", "offline"] as const) {
        yield* Ref.set(visibility, state);
        const target = { threadId: boxThread, environmentId: box.environmentId };
        const toolOutcomes = yield* Effect.forEach(
          [
            ["t3_thread_read", target],
            ["t3_thread_wait", target],
            ["t3_thread_send", { ...target, message: "Carry on." }],
            ["t3_thread_interrupt", { ...target, stop: true }],
          ] as const,
          ([tool, args]) => a.call("thread:laptop-full", tool, args),
        );
        const expected = state === "shared" ? undefined : "thread_not_found";
        expect(toolOutcomes.map((result) => failureOf(result)?.code)).toEqual(
          Array(4).fill(expected),
        );
        const list = yield* a.call("thread:laptop-full", "t3_thread_list", {
          environmentId: box.environmentId,
          projectId: boxProject,
        });
        expect(list.structuredContent).toMatchObject({
          threads: state === "shared" ? [{ threadId: boxThread }] : [],
          total: state === "shared" ? 1 : 0,
        });
        const search = yield* a.call("thread:laptop-full", "t3_thread_search", {
          environmentId: box.environmentId,
          projectId: boxProject,
          query: "Task transcript",
        });
        expect(search.structuredContent).toMatchObject({
          matches: state === "shared" ? [{ threadId: boxThread }] : [],
        });
      }
      expect((yield* Ref.get(seen)).sends).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("only a linked MCP client can read a hand-off bundle near the size limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const bundle = {
        version: 1,
        root: "task",
        tasks: [{ title: "Move me", id: "task" }],
        handoff: "move",
        linked: { board: "shared" },
        extra: "\\".repeat(LINKED_HANDOFF_BUNDLE_MAX_BYTES / 2 - 1024),
      };
      const encoded = JSON.stringify(bundle);
      const bytes = Buffer.byteLength(encoded);
      expect(bytes).toBeGreaterThan(16_000_000);
      const taskDelivery = Layer.effect(
        DeliveryService.DeliveryService,
        Effect.map(DeliveryService.DeliveryService, (service) => ({
          ...service,
          peerHandoff: () =>
            Effect.succeed({
              handoff: "move",
              state: "moving",
              digest: "0".repeat(64),
              bytes,
              to: { peer: "linked", board: "shared" },
              tasks: 1,
              bundle,
            } as const),
        })),
      ).pipe(Layer.provide(DeliveryService.layerTest));
      const b = yield* serveBox(seen, linkSession, taskDelivery);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);
      const request = {
        operation: "prepare",
        taskId: "task",
        handoff: "move",
        boardId: "shared",
      };
      const result = yield* a.peer.call({
        environmentId: box.environmentId,
        tool: "delivery_linked_handoff",
        arguments: { request },
        limits: { runtimeMode: "auto", interactionMode: "default" },
        success: linkedHandoffPeerResult(LinkedHandoffPeerResponses.prepare),
        maxResponseBytes: LINKED_HANDOFF_MCP_MAX_BYTES,
      });
      expect(result.error).toBeNull();
      expect(JSON.stringify(result.data?.bundle)).toBe(encoded);

      const local = yield* a
        .call("thread:laptop-full", "delivery_linked_handoff", { request })
        .pipe(Effect.result);
      expect(local).not.toMatchObject({ _tag: "Success", success: { isError: false } });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("an agent here works on a linked environment's threads within its own modes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);

      const listed = yield* a.call("thread:laptop-full", "t3_environment_links", {});
      expect(listed.structuredContent).toMatchObject({
        environmentId: laptop.environmentId,
        links: [
          { environmentId: box.environmentId, label: "Box", status: "reachable", access: "auto" },
        ],
      });

      const threads = yield* a.call("thread:laptop-full", "t3_thread_list", {
        environmentId: box.environmentId,
        projectId: boxProject,
      });
      expect(threads.isError).toBe(false);
      expect(threads.structuredContent).toMatchObject({
        projectId: boxProject,
        threads: [{ threadId: boxThread, runtimeMode: "auto" }],
      });

      // A full-access agent here is held to the link's `auto` there, which
      // the box's `auto` thread is within.
      const sent = yield* a.call("thread:laptop-full", "t3_thread_send", {
        environmentId: box.environmentId,
        threadId: boxThread,
        message: "Carry on there.",
        clientRequestId: "send-1",
      });
      expect(sent.isError).toBe(false);
      expect(sent.structuredContent).toMatchObject({ threadId: boxThread, delivery: "started" });
      // The box records which thread here sent it.
      expect((yield* Ref.get(seen)).sends[0]?.linkedSender).toEqual({
        environmentId: laptop.environmentId,
        threadId: "thread:laptop-full",
        title: "thread:laptop-full",
      });

      // A plan-mode agent here may not steer that thread there: the box
      // refuses it, because the call carries the agent's own modes.
      const planned = yield* a.call("thread:laptop-plan", "t3_thread_send", {
        environmentId: box.environmentId,
        threadId: boxThread,
        message: "Change course.",
      });
      expect(failureOf(planned)).toMatchObject({ code: "interaction_mode_escalation_denied" });
      expect((yield* Ref.get(seen)).sends).toHaveLength(1);

      // stop=true stops the thread there as its Stop button does: the whole
      // thread and the tasks it delegated, not just the running turn.
      const stopped = yield* a.call("thread:laptop-full", "t3_thread_interrupt", {
        environmentId: box.environmentId,
        threadId: boxThread,
        stop: true,
        clientRequestId: "stop-1",
      });
      expect(stopped.structuredContent).toMatchObject({
        threadId: boxThread,
        runId: boxRun,
        status: "interrupt_requested",
      });
      expect((yield* Ref.get(seen)).stops).toEqual([
        `thread.stop ${boxThread}`,
        `delegated-tasks.stop ${boxThread}`,
      ]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("keeps a forwarded wait short and its retries scoped to the caller", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);

      const waited = yield* a.call("thread:laptop-full", "t3_thread_wait", {
        environmentId: box.environmentId,
        threadId: boxThread,
        timeoutMs: 600_000,
      });
      expect(waited.structuredContent).toEqual({
        threadId: boxThread,
        runId: boxRun,
        status: "completed",
        timedOut: false,
      });
      // One capped piece, so the caller's MCP request returns before its client times out.
      expect((yield* Ref.get(seen)).waits.map(({ timeoutMs }) => timeoutMs)).toEqual([45_000]);

      const send = (caller: string, clientRequestId: string) =>
        a.call(caller, "t3_thread_send", {
          environmentId: box.environmentId,
          threadId: boxThread,
          message: "Once.",
          clientRequestId,
        });
      yield* send("thread:laptop-full", "same-key");
      yield* send("thread:laptop-full", "same-key");
      yield* send("thread:laptop-other", "same-key");
      const [first, retried, other] = (yield* Ref.get(seen)).sends.map((input) => input.commandId);
      // The box sees every caller here as the one link, so the key is scoped
      // to its caller before it leaves: a retry matches, another agent's same
      // key does not.
      expect(retried).toBe(first);
      expect(other).not.toBe(first);
      expect(first).not.toContain("same-key");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("launches in a linked environment with the caller's modes, retry-safe", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "full-access");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);
      const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      const launch = (caller: string, args: Record<string, unknown> = {}) =>
        a.call(caller, "t3_thread_launch", {
          environmentId: box.environmentId,
          projectId: boxProject,
          title: "Run the suite there",
          modelSelection: codex,
          message: "Run the suite.",
          clientRequestId: "launch-1",
          ...args,
        });

      const first = yield* launch("thread:laptop-plan");
      expect(first.isError).toBe(false);
      expect(first.structuredContent).toMatchObject({
        projectId: boxProject,
        modelSelection: codex,
      });
      const retried = yield* launch("thread:laptop-plan");
      const [launched, relaunched] = (yield* Ref.get(seen)).launches;
      // The thread there runs with the caller's own modes here, below the
      // link's full access, and a retry asks for the same thread.
      expect(launched).toMatchObject({ runtimeMode: "full-access", interactionMode: "plan" });
      expect(relaunched?.threadId).toBe(launched?.threadId);
      expect(retried.structuredContent).toEqual(first.structuredContent);

      // An escalation past the caller's own modes is refused here.
      const escalated = yield* launch("thread:laptop-plan", { interactionMode: "default" });
      expect(failureOf(escalated)).toMatchObject({ code: "interaction_mode_escalation_denied" });
      // A pending upload lives here, so it cannot go along.
      yield* Ref.set(b.bearers, []);
      const withUpload = yield* launch("thread:laptop-full", {
        clientRequestId: "launch-2",
        attachments: [
          { type: "image", id: "upload-1", name: "a.png", mimeType: "image/png", sizeBytes: 1 },
        ],
      });
      expect(failureOf(withUpload)).toMatchObject({ code: "invalid_request" });
      expect(yield* Ref.get(b.bearers)).toEqual([]);
      expect((yield* Ref.get(seen)).launches).toHaveLength(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("brings a repository to a linked environment, only through full access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const b = yield* serveBox(seen, yield* Ref.make(""));
      const a = yield* makeLaptop;
      const clone = { repository: "pingdotgg/t3code", destinationPath: "/home/box/t3code" };
      const register = { title: "t3code", workspaceRoot: "/home/box/t3code" };

      yield* linkTo(a.links, b, "full-access");
      const cloned = yield* a.call("thread:laptop-full", "t3_project_clone", {
        environmentId: box.environmentId,
        ...clone,
      });
      expect(cloned.structuredContent).toMatchObject({ cwd: clone.destinationPath });
      const created = yield* a.call("thread:laptop-full", "t3_project_create", {
        environmentId: box.environmentId,
        ...register,
      });
      expect(created.structuredContent).toMatchObject(register);
      expect((yield* Ref.get(seen)).clones).toEqual([clone]);
      expect((yield* Ref.get(seen)).projects).toMatchObject([register]);

      // A plan-mode agent here may not, and nothing leaves.
      yield* Ref.set(b.bearers, []);
      const planned = yield* a.call("thread:laptop-plan", "t3_project_create", {
        environmentId: box.environmentId,
        ...register,
      });
      expect(failureOf(planned)).toMatchObject({ code: "capability_denied" });
      expect(yield* Ref.get(b.bearers)).toEqual([]);

      // Nor may a full-access agent through a link with less: the box holds it.
      yield* linkTo(a.links, b, "auto");
      for (const [name, args] of [
        ["t3_project_clone", clone],
        ["t3_project_create", register],
      ] as const) {
        const refused = yield* a.call("thread:laptop-full", name, {
          environmentId: box.environmentId,
          ...args,
        });
        const failure = failureOf(refused);
        expect(failure, name).toMatchObject({ code: "capability_denied" });
        // The agent's thread is full access; what holds it is the link's access.
        expect(failure.message, name).toContain("linked environment");
        expect(failure.message, name).not.toContain("calling thread");
      }
      expect((yield* Ref.get(seen)).clones).toHaveLength(1);
      expect((yield* Ref.get(seen)).projects).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("runs any tool that takes a linked environment there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);

      const there = yield* a.call("thread:laptop-full", "t3_thread_configure", {
        environmentId: box.environmentId,
        threadId: boxThread,
      });
      expect(there.structuredContent).toMatchObject({ threadId: boxThread, runtimeMode: "auto" });
      const archived = yield* a.call("thread:laptop-full", "t3_thread_organize", {
        environmentId: box.environmentId,
        threadId: boxThread,
        action: "archive",
      });
      expect(archived.isError).toBe(false);
      expect((yield* Ref.get(seen)).stops).toEqual([`thread.archive ${boxThread}`]);
      // A cursorless read from here gets the newest page there, as it does locally.
      const read = yield* a.call("thread:laptop-full", "t3_thread_read", {
        environmentId: box.environmentId,
        threadId: boxThread,
      });
      expect(read.isError).toBe(false);
      const clientRead = yield* a.callAsClient("t3_thread_read", {
        environmentId: box.environmentId,
        threadId: boxThread,
      });
      expect(clientRead.isError).toBe(false);
      expect((yield* Ref.get(seen)).reads).toEqual([
        { beforePosition: Number.MAX_SAFE_INTEGER, limit: 10, view: "messages" },
        { beforePosition: Number.MAX_SAFE_INTEGER, limit: 10, view: "messages" },
      ]);

      // This environment's own id keeps the call here.
      const own = yield* a.call("thread:laptop-full", "t3_thread_configure", {
        environmentId: laptop.environmentId,
      });
      expect(own.structuredContent).toMatchObject({
        threadId: "thread:laptop-full",
        runtimeMode: "full-access",
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses what a linked environment cannot take before anything leaves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);
      yield* Ref.set(b.bearers, []);

      const unknown = yield* a.call("thread:laptop-full", "t3_thread_read", {
        environmentId: EnvironmentId.make("environment-elsewhere"),
        threadId: boxThread,
      });
      expect(failureOf(unknown)).toMatchObject({ code: "invalid_request" });
      expect(yield* Ref.get(b.bearers)).toEqual([]);

      // The box sees only the link's credential, so one that may not control
      // threads here may not reach them there either.
      const previewOnly = new Set<McpInvocationContext.McpCapability>(["preview"]);
      for (const [name, args] of [
        ["t3_environment_links", {}],
        ["t3_project_list", { environmentId: box.environmentId }],
        ["t3_thread_list", { environmentId: box.environmentId, projectId: boxProject }],
        ["t3_thread_read", { environmentId: box.environmentId, threadId: boxThread }],
        ["t3_thread_wait", { environmentId: box.environmentId, threadId: boxThread }],
        [
          "t3_thread_send",
          { environmentId: box.environmentId, threadId: boxThread, message: "Carry on there." },
        ],
        [
          "t3_thread_organize",
          { environmentId: box.environmentId, threadId: boxThread, action: "archive" },
        ],
        [
          "t3_thread_launch",
          {
            environmentId: box.environmentId,
            projectId: boxProject,
            title: "Start there",
            modelSelection: { instanceId: "codex", model: "gpt-5" },
            message: "Start there.",
          },
        ],
      ] as const) {
        const refused = yield* a.call("thread:laptop-full", name, args, previewOnly);
        expect(failureOf(refused), name).toMatchObject({ code: "capability_denied" });
      }
      expect(yield* Ref.get(b.bearers)).toEqual([]);

      // Work a desk's link started here never uses this laptop's links: the
      // box would see the laptop, not the desk, so its fence could not hold.
      for (const [name, args] of [
        ["t3_thread_read", { environmentId: box.environmentId, threadId: boxThread }],
        [
          "t3_thread_send",
          { environmentId: box.environmentId, threadId: boxThread, message: "From the desk." },
        ],
        [
          "t3_thread_launch",
          { environmentId: box.environmentId, projectId: boxProject, title: "x" },
        ],
      ] as const) {
        const relayed = yield* a.call("thread:laptop-from-desk", name, args);
        expect(failureOf(relayed), name).toMatchObject({ code: "capability_denied" });
      }
      expect(yield* Ref.get(b.bearers)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses a launch there above the link's access, naming the link", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);

      // A full-access agent here asks for more than the link allows there.
      const launchAboveLink = a.call("thread:laptop-full", "t3_thread_launch", {
        environmentId: box.environmentId,
        projectId: boxProject,
        title: "Run the suite there",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        message: "Run the suite.",
        runtimeMode: "full-access",
      });
      const { message } = failureOf(yield* launchAboveLink);
      expect(message).toContain('"Box"');
      expect(message).toContain("auto");
      expect(message).toContain("full-access");
      expect(message).not.toContain("parent mode");
      expect((yield* Ref.get(seen)).launches).toEqual([]);

      // Once the link has expired, that is what the agent needs to hear.
      yield* TestClock.adjust(Duration.days(31));
      expect(failureOf(yield* launchAboveLink).message).toContain("expired");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const refusedRead = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const beforePositionRefusal = refusedRead(
  `Invalid parameters for tool 't3_thread_read': Unknown argument "beforePosition". Accepted arguments: limit, view.`,
);

it("recognizes only a validation refusal of beforePosition", () => {
  const cases: Array<[OrchestratorMcpFailure, boolean]> = [
    [beforePositionRefusal, true],
    [
      refusedRead(
        `Invalid parameters for tool 't3_thread_read': Unknown arguments "runLimit", "beforePosition". Accepted arguments: limit.`,
      ),
      true,
    ],
    [refusedRead(`Invalid parameters for tool 't3_thread_read': Unknown argument "limit".`), false],
    // A thread id can carry the same words; only the refusal's code and prefix count.
    [
      new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: `Thread Unknown argument "beforePosition". Accepted arguments: x. is no longer available.`,
      }),
      false,
    ],
  ];
  for (const [failure, expected] of cases) {
    expect(PeerForwarding.refusesBeforePosition(failure)).toBe(expected);
  }
});

it.effect("retries a newest-page read without its cursor when the peer refuses the cursor", () =>
  Effect.gen(function* () {
    const sent: Array<unknown> = [];
    const olderPeer = (args: unknown): Effect.Effect<string, OrchestratorMcpFailure> => {
      sent.push(args);
      return "beforePosition" in (args as object)
        ? Effect.fail(beforePositionRefusal)
        : Effect.succeed("forward page");
    };
    const params = { threadId: "thread:box-auto", limit: 35 };
    const newest = { ...params, beforePosition: Number.MAX_SAFE_INTEGER };

    const page = yield* PeerForwarding.readNewestOrRetry(olderPeer, newest, params);

    expect(page).toBe("forward page");
    expect(sent).toEqual([newest, params]);
  }),
);
