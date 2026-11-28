import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import { filterPeerThreadRows } from "../../../delivery/linkedThreadAccess.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Workflows from "../../../workflows/Workflows.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { callerLinkOrigin } from "../../linkOrigin.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WORKFLOW_READ_ACTIONS, WorkflowToolkit } from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(invalid(`This action needs \`${name}\`.`))
    : Effect.succeed(value);
const refused = (error: Workflows.WorkflowError) => invalid(error.message);
const isRead = (action: string): action is (typeof WORKFLOW_READ_ACTIONS)[number] =>
  (WORKFLOW_READ_ACTIONS as ReadonlyArray<string>).includes(action);

const runNotFound = () => invalid("The workflow run was not found.");
const ownerOnly = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "This workflow action is available only to the environment owner.",
  });

const controlsRun = Effect.fn("mcp.workflow.controlsRun")(function* (
  workflows: Workflows.Workflows["Service"],
  scope: McpInvocationContext.McpInvocationScope,
  runId: string,
) {
  if (!McpInvocationContext.isLinkedDeliveryCaller(scope)) return true;
  const caller = callerLinkOrigin({ scope, caller: undefined });
  return (
    caller !== undefined &&
    (yield* workflows.launchOrigin(runId))?.linkOrigin?.sessionId === caller.sessionId
  );
});

const assertRunAccess = Effect.fn("mcp.workflow.assertRunAccess")(function* (
  workflows: Workflows.Workflows["Service"],
  scope: McpInvocationContext.McpInvocationScope,
  runId: string,
) {
  if (!(yield* controlsRun(workflows, scope, runId))) return yield* runNotFound();
});

type ThreadReference = { readonly threadId: string | null; readonly environmentId: string | null };

const visibleThreads = Effect.fn("mcp.workflow.visibleThreads")(function* (
  scope: McpInvocationContext.McpInvocationScope,
  references: ReadonlyArray<ThreadReference>,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const local = new Set(
    references.flatMap(({ threadId, environmentId }) =>
      threadId !== null && (environmentId === null || environmentId === scope.environmentId)
        ? [ThreadId.make(threadId)]
        : [],
    ),
  );
  return new Set<string>(yield* filterPeerThreadRows(scope, [...local], (id) => id, threads));
});

const readRun = Effect.fn("mcp.workflow.readRun")(function* (
  workflows: Workflows.Workflows["Service"],
  scope: McpInvocationContext.McpInvocationScope,
  runId: string,
) {
  yield* assertRunAccess(workflows, scope, runId);
  const result = yield* workflows.get(runId).pipe(Effect.mapError(refused));
  if (!McpInvocationContext.isLinkedDeliveryCaller(scope)) return result;
  const visible = yield* visibleThreads(scope, result.steps);
  return {
    ...result,
    steps: result.steps.map((step) =>
      step.threadId === null ||
      ((step.environmentId === null || step.environmentId === scope.environmentId) &&
        visible.has(step.threadId))
        ? step
        : { ...step, threadId: null, environmentId: null, result: null, said: null, detail: null },
    ),
  };
});

export const layer = McpToolAccess.toLayer(WorkflowToolkit, {
  t3_workflow: McpToolAccess.either(
    (input) => isRead(input.action),
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const linked = McpInvocationContext.isLinkedDeliveryCaller(scope);
        if (input.action === "questions") {
          const all = yield* workflows.questions.pipe(Effect.mapError(refused));
          const matching =
            input.kind === undefined ? all : all.filter((question) => question.kind === input.kind);
          if (!linked) return { questions: matching };
          const questions = yield* Effect.filter(matching, (question) =>
            controlsRun(workflows, scope, question.runId),
          );
          const visible = yield* visibleThreads(
            scope,
            questions.flatMap(({ thread }) => (thread === null ? [] : [thread])),
          );
          return {
            questions: questions.map((question) => {
              const { thread } = question;
              return thread !== null &&
                (thread.environmentId === null || thread.environmentId === scope.environmentId) &&
                visible.has(thread.threadId)
                ? question
                : { ...question, thread: null };
            }),
          };
        }
        if (input.action === "store") {
          return {
            entries: linked
              ? []
              : yield* workflows.stored(input.key ?? "").pipe(Effect.mapError(refused)),
          };
        }
        if (input.action === "list") {
          const runs = yield* workflows
            .list({
              ...(input.status === undefined ? {} : { status: input.status }),
              ...(input.tag === undefined ? {} : { tag: input.tag }),
              ...(input.subject === undefined ? {} : { subject: input.subject }),
            })
            .pipe(Effect.mapError(refused));
          return {
            runs: linked
              ? yield* Effect.filter(runs, (run) => controlsRun(workflows, scope, run.runId))
              : runs,
          };
        }
        const runId = yield* required(input.runId, "runId");
        return yield* readRun(workflows, scope, runId);
      }),
    ),
    McpToolAccess.writesOwnerWork("start or change workflow runs, or read hook paths", (input) =>
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const linked = McpInvocationContext.isLinkedDeliveryCaller(scope);
        // A hook's path holds its secret, and posting to it starts a run.
        if (input.action === "hooks") {
          if (linked) return yield* ownerOnly();
          return { hooks: yield* workflows.hooks.pipe(Effect.mapError(refused)) };
        }
        if (input.action === "start") {
          const name = yield* required(input.workflow, "workflow");
          const idempotencyKey = yield* required(input.idempotencyKey, "idempotencyKey");
          const linkOrigin = callerLinkOrigin({ scope, caller: undefined });
          if (scope.thread?.deliveryOriginUnknown === true && linkOrigin === undefined) {
            return yield* invalid("Could not verify the originating thread for this workflow.");
          }
          const launchedFromThreadId = scope.thread?.threadId;
          const launchOrigin =
            linkOrigin === undefined && launchedFromThreadId === undefined
              ? undefined
              : {
                  ...(linkOrigin === undefined ? {} : { linkOrigin }),
                  ...(launchedFromThreadId === undefined ? {} : { launchedFromThreadId }),
                };
          const { runId } = yield* workflows
            .start(name, input.input === undefined ? {} : input.input, {
              idempotencyKey,
              ...(launchOrigin === undefined ? {} : { launchOrigin }),
            })
            .pipe(Effect.mapError(refused));
          return yield* readRun(workflows, scope, runId);
        }
        if (input.action === "signal") {
          const value = yield* required(input.value, "value");
          const byRun = input.runId !== undefined || input.wait !== undefined;
          const byChannel = input.workflow !== undefined || input.channel !== undefined;
          if (byRun && byChannel) {
            return yield* invalid(
              "Address a signal with `runId` and `wait`, or with `workflow` and `channel`, not both.",
            );
          }
          const address =
            input.runId !== undefined && input.wait !== undefined
              ? { runId: input.runId, wait: input.wait }
              : input.workflow !== undefined && input.channel !== undefined
                ? { workflow: input.workflow, channel: input.channel }
                : undefined;
          if (address === undefined) {
            return yield* invalid(
              "Address a signal with `runId` and `wait`, or `workflow` and `channel`.",
            );
          }
          if (linked && !("runId" in address)) return yield* ownerOnly();
          if ("runId" in address) yield* assertRunAccess(workflows, scope, address.runId);
          const random = yield* SecureRandom.SecureRandom;
          const id = input.signalId ?? (yield* random.uuidV4());
          // The server refuses a thread's call to this tool, so the caller is a client. An agent
          // answers through the CLI, a client it names after its thread.
          const answeredBy = scope.client?.label;
          const delivery = yield* workflows
            .signal(address, value, { id, ...(answeredBy === undefined ? {} : { answeredBy }) })
            .pipe(Effect.mapError(refused));
          return { delivery };
        }
        if (input.action === "withdraw") {
          const runId = yield* required(input.runId, "runId");
          const wait = yield* required(input.wait, "wait");
          yield* assertRunAccess(workflows, scope, runId);
          const by =
            scope.thread !== undefined
              ? `thread ${scope.thread.threadId}`
              : (scope.client?.label ?? "a person");
          const withdrawal = yield* workflows
            .withdraw(runId, wait, { by, reason: input.reason })
            .pipe(Effect.mapError(refused));
          return { withdrawal, ...(yield* readRun(workflows, scope, runId)) };
        }
        if (input.action === "store_set" || input.action === "store_delete") {
          if (linked) return yield* ownerOnly();
          const key = yield* required(input.key, "key");
          const value =
            input.action === "store_set" ? yield* required(input.value, "value") : undefined;
          yield* (
            value === undefined ? workflows.storeDelete(key) : workflows.storeSet(key, value)
          ).pipe(Effect.mapError(refused));
          return { entries: yield* workflows.stored(key).pipe(Effect.mapError(refused)) };
        }
        const runId = yield* required(input.runId, "runId");
        yield* assertRunAccess(workflows, scope, runId);
        yield* (
          input.action === "resume"
            ? workflows.resume(runId)
            : workflows.cancel(runId, input.reason)
        ).pipe(Effect.mapError(refused));
        return yield* readRun(workflows, scope, runId);
      }),
    ),
  ),
});
