import {
  DELIVERY_HARNESS_BY_DRIVER,
  DeliveryNativeBuildStepInput,
  DeliveryNativeBuildStepResult,
  NodeId,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../mcp/OrchestratorMcpService.ts";
import { DeliveryService, sameFolder } from "./DeliveryService.ts";

const NativeBuild = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  worktree: Schema.String,
  harness: Schema.String,
  model: Schema.NullOr(Schema.String),
  prompt: Schema.String,
  access: Schema.Literal("full"),
  state: Schema.String,
  owner: Schema.NullOr(Schema.String),
  cancelRequested: Schema.Boolean,
  native: Schema.NullOr(Schema.Struct({ taskId: Schema.String, childThreadId: Schema.String })),
});

const decodeNativeBuild = Schema.decodeUnknownEffect(NativeBuild);
const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export class NativeBuildExecution extends Context.Service<
  NativeBuildExecution,
  {
    readonly step: (
      scope: McpInvocationScope,
      input: typeof DeliveryNativeBuildStepInput.Type,
    ) => Effect.Effect<typeof DeliveryNativeBuildStepResult.Type, OrchestratorMcpFailure>;
  }
>()("t3/delivery/NativeBuildExecution") {}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const delivery = yield* DeliveryService;
  const orchestrator = yield* OrchestratorMcpService;
  return NativeBuildExecution.of({
    step: Effect.fn("NativeBuildExecution.step")(function* (scope, input) {
      if (!/^att-[A-Za-z0-9-]+$/.test(input.attemptId))
        return yield* refused("Invalid native attempt id.");
      if (!scope.thread)
        return yield* refused(
          "Native builds require an active T3 coordinator thread attached to the build worktree.",
        );
      const owner = `${scope.environmentId}:${scope.thread.threadId}`;
      const endpoint = `/api/native-builds/${encodeURIComponent(input.attemptId)}`;
      const recordOf = (body: unknown) =>
        decodeNativeBuild(body).pipe(
          Effect.mapError(() =>
            refused("The engine did not return a compatible native build request."),
          ),
        );
      const read = delivery.read({ path: endpoint }).pipe(
        Effect.mapError((error) => refused(error.detail)),
        Effect.flatMap((response) => recordOf(response.body)),
      );
      const post = (action: string, body: unknown) =>
        delivery.nativeBuildAct({ path: `${endpoint}/${action}`, body }).pipe(
          Effect.mapError((error) => refused(error.detail)),
          Effect.flatMap((response) => recordOf(response.body)),
        );
      let build = yield* read;
      if (build.id !== input.attemptId)
        return yield* refused("The engine returned another attempt.");
      if (build.owner !== null && build.owner !== owner)
        return yield* refused("Another coordinator owns this native build.");
      const parent = yield* orchestrator.readThread(scope, {
        threadId: scope.thread.threadId,
        limit: 1,
        maxCharsPerItem: 1,
      });
      if (
        !parent.thread.worktreePath ||
        !sameFolder(parent.thread.worktreePath, build.worktree, platform)
      ) {
        return yield* refused(
          "Attach this coordinator to the engine build's existing worktree. Native builds cannot change or transfer authority to another checkout.",
        );
      }
      if (["completed", "failed", "cancelled", "interrupted"].includes(build.state))
        return { attemptId: build.id, state: build.state, taskId: build.native?.taskId ?? null };
      // This namespace survives provider-session and engine restarts. Replaying an uncertain
      // dispatch recovers its native receipt rather than admitting a second writable child.
      const nativeScope = { ...scope, requestNamespace: `delivery-native:${owner}:${build.id}` };
      if (!build.native) {
        const capabilities = yield* orchestrator.capabilities(scope);
        const candidates = capabilities.providers.filter(
          (provider) =>
            provider.canRunChildTask &&
            DELIVERY_HARNESS_BY_DRIVER[provider.driverKind] === build.harness,
        );
        const provider =
          candidates.find(
            (provider) => provider.providerInstanceId === scope.thread?.providerInstanceId,
          ) ?? (candidates.length === 1 ? candidates[0] : undefined);
        if (!provider)
          return yield* refused(
            "The engine harness does not identify one enabled native provider instance.",
          );
        const model =
          build.model ??
          (provider.providerInstanceId === scope.thread.providerInstanceId
            ? capabilities.inheritedModel
            : null);
        if (!model)
          return yield* refused("A native build on another provider needs an explicit model.");
        if (
          capabilities.runtimeMode !== "full-access" ||
          (provider.runtimeModes && !provider.runtimeModes.includes("full-access"))
        )
          return yield* refused(
            "Native builds require a full-access coordinator and provider; approval modes do not grant filesystem access.",
          );
        build = yield* post("claim", { owner, worktree: build.worktree });
        const task = yield* orchestrator.delegateTask(nativeScope, {
          task: build.prompt,
          title: `Team build ${build.id}`,
          clientRequestId: "execute-v1",
          isolation: "shared",
          mode: "async",
          runtimeMode: "full-access",
          target: { providerInstanceId: provider.providerInstanceId, model, options: [] },
        });
        if (!task.childThreadId)
          return yield* refused(
            "Native admission returned no child thread. Retry this attempt to recover the receipt.",
          );
        build = yield* post("attach", {
          owner,
          taskId: task.taskId,
          childThreadId: task.childThreadId,
        });
      }
      if (!build.native) return yield* refused("The native task receipt is missing.");
      const taskId = NodeId.make(build.native.taskId);
      if (build.cancelRequested)
        yield* orchestrator.cancelTask(nativeScope, {
          taskId,
          clientRequestId: "cancel-v1",
          reason: "The delivery engine requested cancellation.",
        });
      const status = yield* orchestrator.taskStatus(nativeScope, taskId);
      if (
        status.workState !== "result_available" ||
        status.hasPendingChildRuns ||
        !status.latestTerminalStatus
      ) {
        return {
          attemptId: build.id,
          state: build.cancelRequested ? "cancelling" : "working",
          taskId,
        };
      }
      let text = "";
      if (status.latestTerminalStatus === "completed") {
        let afterPosition: number | undefined;
        let answer:
          | Awaited<Effect.Success<ReturnType<typeof orchestrator.readThread>>>["items"][number]
          | undefined;
        do {
          const transcript = yield* orchestrator.readThread(nativeScope, {
            threadId: ThreadId.make(build.native.childThreadId),
            limit: 100,
            maxCharsPerItem: 50000,
            ...(afterPosition === undefined ? {} : { afterPosition }),
          });
          answer =
            transcript.items.findLast(
              (item) =>
                item.runId === status.latestTerminalRunId && item.type === "assistant_message",
            ) ?? answer;
          if (!transcript.hasMore) break;
          if (
            transcript.nextPosition === null ||
            (afterPosition !== undefined && transcript.nextPosition <= afterPosition)
          )
            return yield* refused("The native transcript did not advance while paging.");
          afterPosition = transcript.nextPosition;
        } while (true);
        if (!answer || answer.textTruncated || answer.text === null)
          return yield* refused(
            "The native final answer is not available in full. The attempt remains held for reconciliation.",
          );
        text = answer.text;
      }
      build = yield* post("complete", {
        owner,
        taskId,
        state: status.latestTerminalStatus,
        text,
        reason:
          status.latestTerminalStatus === "completed"
            ? null
            : `Native task ended ${status.latestTerminalStatus}.`,
      });
      return { attemptId: build.id, state: build.state, taskId };
    }),
  });
});

export const layer = Layer.effect(NativeBuildExecution, make);
