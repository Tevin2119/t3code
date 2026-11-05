import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { DeliveryService } from "./DeliveryService.ts";
import { OrchestratorMcpService } from "../mcp/OrchestratorMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { make } from "./NativeBuildExecution.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "session-one",
  thread: {
    threadId: ThreadId.make("parent"),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};

function setup({ mismatch = false, attachFailure = false, paged = false } = {}) {
  let build = {
    version: 1,
    id: "att-one",
    worktree: "C:/build/worktree",
    harness: "codex",
    model: "model",
    prompt: "Build and return JSON.",
    access: "full",
    state: "queued",
    owner: null as string | null,
    cancelRequested: false,
    native: null as { taskId: string; childThreadId: string } | null,
  };
  let nativeState = "running";
  const admissions = new Set<string>();
  const readThread = vi.fn(
    (_caller: McpInvocationScope, input: { threadId: string; afterPosition?: number }) =>
      Effect.succeed(
        input.threadId === "parent"
          ? { thread: { worktreePath: mismatch ? "C:/another/worktree" : build.worktree } }
          : paged && input.afterPosition === undefined
            ? { hasMore: true, nextPosition: 100, items: [] }
            : {
                hasMore: false,
                items: [
                  {
                    runId: "native-run",
                    type: "assistant_message",
                    textTruncated: false,
                    text: '{"summary":"done"}',
                  },
                ],
              },
      ),
  );
  const delegateTask = vi.fn((caller: McpInvocationScope, input: { clientRequestId: string }) => {
    admissions.add(`${caller.requestNamespace}:${input.clientRequestId}`);
    return Effect.succeed({ taskId: "native-task", childThreadId: "native-thread" });
  });
  const cancelTask = vi.fn(() => {
    nativeState = "cancelled";
    return Effect.succeed({ taskId: "native-task", status: "cancelled" });
  });
  const orchestrator = {
    readThread,
    delegateTask,
    cancelTask,
    capabilities: () =>
      Effect.succeed({
        inheritedModel: "model",
        runtimeMode: "full-access",
        providers: [{ providerInstanceId: "codex", driverKind: "codex", canRunChildTask: true }],
      }),
    taskStatus: () =>
      Effect.succeed({
        workState: nativeState === "running" ? "working" : "result_available",
        hasPendingChildRuns: false,
        latestTerminalStatus: nativeState === "running" ? null : nativeState,
        latestTerminalRunId: "native-run",
      }),
  } as unknown as OrchestratorMcpService["Service"];
  const completed: unknown[] = [];
  const delivery = {
    read: () => Effect.succeed({ body: build }),
    nativeBuildAct: ({
      path,
      body,
    }: {
      path: string;
      body: { owner: string; taskId: string; childThreadId: string; state: string };
    }) => {
      if (path.endsWith("/claim")) build = { ...build, owner: body.owner, state: "claimed" };
      if (path.endsWith("/attach")) {
        if (attachFailure) {
          attachFailure = false;
          return Effect.fail({ detail: "lost attach response" });
        }
        build = { ...build, native: { taskId: body.taskId, childThreadId: body.childThreadId } };
      }
      if (path.endsWith("/complete")) {
        completed.push(body);
        build = { ...build, state: body.state };
      }
      return Effect.succeed({ body: build });
    },
  } as unknown as DeliveryService["Service"];
  const service = () =>
    make.pipe(
      Effect.provideService(DeliveryService, delivery),
      Effect.provideService(OrchestratorMcpService, orchestrator),
      Effect.provideService(HostProcess.Platform, "win32"),
    );
  return {
    service,
    delegateTask,
    cancelTask,
    admissions,
    completed,
    setNativeState: (state: string) => {
      nativeState = state;
    },
    requestCancel: () => {
      build = { ...build, cancelRequested: true };
    },
  };
}

it.effect("rejects checkout mismatch before native admission", () =>
  Effect.gen(function* () {
    const fixture = setup({ mismatch: true });
    const service = yield* fixture.service();
    const failure = yield* service.step(scope, { attemptId: "att-one" }).pipe(Effect.flip);
    expect(failure.message).toMatch(/existing worktree/);
    expect(fixture.delegateTask).not.toHaveBeenCalled();
  }),
);
it.effect(
  "recovers uncertain dispatch with a stable native receipt across coordinator sessions",
  () =>
    Effect.gen(function* () {
      const fixture = setup({ attachFailure: true });
      const first = yield* fixture.service();
      const failure = yield* first.step(scope, { attemptId: "att-one" }).pipe(Effect.flip);
      expect(failure.message).toMatch(/lost attach/);
      const recovered = yield* fixture.service();
      const nextScope = { ...scope, requestNamespace: "session-two" };
      expect((yield* recovered.step(nextScope, { attemptId: "att-one" })).state).toBe("working");
      expect(fixture.admissions.size).toBe(1);
      fixture.setNativeState("completed");
      expect((yield* recovered.step(nextScope, { attemptId: "att-one" })).state).toBe("completed");
      expect(fixture.completed).toEqual([
        expect.objectContaining({
          state: "completed",
          text: '{"summary":"done"}',
          taskId: "native-task",
        }),
      ]);
    }),
);
it.effect(
  "reconciles engine cancellation using native cancellation and native terminal state",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const service = yield* fixture.service();
      yield* service.step(scope, { attemptId: "att-one" });
      fixture.requestCancel();
      expect((yield* service.step(scope, { attemptId: "att-one" })).state).toBe("cancelled");
      expect(fixture.cancelTask).toHaveBeenCalledOnce();
      expect(fixture.completed).toEqual([
        expect.objectContaining({ state: "cancelled", text: "" }),
      ]);
    }),
);

it.effect("rejects an unsafe attempt id before relaying any native operation", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const service = yield* fixture.service();
    const failure = yield* service.step(scope, { attemptId: "../tasks" }).pipe(Effect.flip);
    expect(failure.message).toMatch(/Invalid native attempt/);
    expect(fixture.delegateTask).not.toHaveBeenCalled();
  }),
);
it.effect("pages the native transcript to obtain the authoritative final result", () =>
  Effect.gen(function* () {
    const fixture = setup({ paged: true });
    const service = yield* fixture.service();
    yield* service.step(scope, { attemptId: "att-one" });
    fixture.setNativeState("completed");
    expect((yield* service.step(scope, { attemptId: "att-one" })).state).toBe("completed");
    expect(fixture.completed).toEqual([expect.objectContaining({ text: '{"summary":"done"}' })]);
  }),
);
