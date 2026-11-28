import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadIssueService from "../orchestration-v2/ThreadIssueService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkflowAgentThreads from "./WorkflowAgentThreads.ts";
import { WorkflowAgents } from "./WorkflowAgents.ts";
import { unavailable, WorkflowForge } from "./WorkflowForge.ts";

it.effect("a revoked workflow link cannot dispatch another agent turn", () =>
  Effect.gen(function* () {
    const sessions = yield* AuthSessions.AuthSessionRepository;
    const now = yield* DateTime.now;
    const sessionId = AuthSessionId.make("incoming-peer");
    const linkOrigin = { sessionId, label: "Peer", access: "auto" } as const;
    yield* sessions.create({
      sessionId,
      subject: "peer",
      method: "bearer-access-token",
      scopes: [],
      client: {
        label: linkOrigin.label,
        ipAddress: null,
        userAgent: null,
        deviceType: "unknown",
        os: null,
        browser: null,
      },
      issuedAt: now,
      expiresAt: DateTime.add(now, { minutes: 60 }),
      peerArrivalKey: "fixture-key",
    });
    const thread = { ...liveThreadShell(ThreadId.make("workflow-thread")), linkOrigin };
    const attempted = yield* Ref.make(0);
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      ServerSettings.layerTest(),
      Layer.succeed(WorkflowForge, unavailable),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(thread),
        sendToThread: ({ projectId, threadId }) =>
          Ref.update(attempted, (count) => count + 1).pipe(
            Effect.andThen(
              new ThreadManagement.ThreadManagementThreadNotFoundError({ projectId, threadId }),
            ),
          ),
      }),
      Layer.mock(ThreadIssueService.ThreadIssueService)({}),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(PeerLinks.PeerLinks)({}),
      Layer.mock(PeerMcpClient.PeerMcpClient)({}),
    );
    yield* Effect.gen(function* () {
      const agents = yield* WorkflowAgents;
      const input = {
        origin: { runId: "run", workflow: "workflow", step: "continue" },
        title: "Continue",
        prompt: "Continue work",
        outputSchema: undefined,
        model: undefined,
        project: undefined,
        environment: undefined,
        thread: thread.id,
      };
      const launchOrigin = { linkOrigin };
      const active = yield* agents
        .start({ ...input, launchOrigin, key: "first" })
        .pipe(Effect.flip);
      assert.include(active.reason, "Could not send to the thread");
      yield* sessions.revoke({ sessionId, revokedAt: now });
      const blocked = yield* agents
        .start({ ...input, launchOrigin, key: "next" })
        .pipe(Effect.flip);
      assert.equal(blocked.reason, "The workflow's link session was revoked or expired.");
      assert.equal(yield* Ref.get(attempted), 1);
      const owner = yield* agents.start({ ...input, key: "owner" }).pipe(Effect.flip);
      assert.include(owner.reason, "Could not send to the thread");
      assert.equal(yield* Ref.get(attempted), 2);
    }).pipe(Effect.provide(WorkflowAgentThreads.layer.pipe(Layer.provide(dependencies))));
  }).pipe(
    Effect.provide(AuthSessions.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);
