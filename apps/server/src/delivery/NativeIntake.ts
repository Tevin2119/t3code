import { CommandId, MessageId, ModelSelection, ProjectId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as DeliveryService from "./DeliveryService.ts";

const Seat = Schema.Struct({
  id: Schema.String,
  providerInstanceId: Schema.String,
  model: Schema.String,
  options: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])),
});
const Profile = Schema.Struct({
  profile: Schema.Literal("payoutlab-discord-triage"),
  runtime: Schema.Literal("t3-native"),
  paperclip: Schema.Struct({
    board: Schema.Literal("payoutlab-discord-bugs"),
    team: Schema.Literal("payoutlab-discord-triage"),
    workflow: Schema.Literal("plan"),
  }),
  repositories: Schema.Struct({ planningTarget: Schema.String }),
  nativeSeats: Schema.Array(Seat),
});
const Job = Schema.Struct({
  id: Schema.String,
  generation: Schema.Int,
  state: Schema.String,
  owner: Schema.NullOr(Schema.String),
  native: Schema.NullOr(Schema.Struct({ threadId: Schema.String, runId: Schema.String })),
  cancelRequested: Schema.Boolean,
  profilePath: Schema.String,
  projectId: Schema.String,
  board: Schema.Literal("payoutlab-discord-bugs"),
  team: Schema.Literal("payoutlab-discord-triage"),
  workflow: Schema.Literal("plan"),
  workspace: Schema.String,
  ticketId: Schema.String,
  digest: Schema.String,
  evidencePath: Schema.String,
  prompt: Schema.String,
  seats: Schema.Array(Seat),
});
const Pending = Schema.Struct({
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  pending: Schema.Array(Schema.Struct({ id: Schema.String })),
});
const decodeJob = Schema.decodeUnknownEffect(Job);
const decodePending = Schema.decodeUnknownEffect(Pending);
const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(Profile));
const decodeSelection = Schema.decodeUnknownEffect(ModelSelection);
const encodeSeats = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Seat)));
const terminal = (state: string) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(state);
const roles = ["reproduction", "data-infrastructure", "independent-verifier"] as const;

export class NativeIntakeError extends Schema.TaggedError<NativeIntakeError>()(
  "NativeIntakeError",
  {
    reason: Schema.Literals(["binding", "roster", "receipt", "report", "transport"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class NativeIntake extends Context.Service<
  NativeIntake,
  {
    readonly reconcile: () => Effect.Effect<void, NativeIntakeError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/delivery/NativeIntake") {}

const selection = (seat: typeof Seat.Type) =>
  decodeSelection({
    instanceId: seat.providerInstanceId,
    model: seat.model,
    options: seat.options,
  });
const sameSeat = (a: typeof Seat.Type, b: typeof Seat.Type) =>
  a.id === b.id &&
  a.providerInstanceId === b.providerInstanceId &&
  a.model === b.model &&
  Object.keys(a.options).length === Object.keys(b.options).length &&
  Object.entries(a.options).every(([key, value]) => b.options[key] === value);

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const delivery = yield* DeliveryService.DeliveryService;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const lock = yield* Semaphore.make(1);
  const owner = `t3-native-intake:${yield* identity.getEnvironmentId}`;
  const safe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new NativeIntakeError({ reason: "transport", cause })));

  const reconcileJob = Effect.fn("NativeIntake.reconcileJob")(function* (
    job: typeof Job.Type,
    profile: typeof Profile.Type | null,
    projectId: ProjectId,
    profilePath: string,
    enabled: boolean,
  ) {
    if (
      !/^intake-[a-f0-9]{64}$/.test(job.id) ||
      job.generation < 0 ||
      job.projectId !== projectId ||
      !DeliveryService.sameFolder(job.profilePath, profilePath, platform)
    )
      return yield* new NativeIntakeError({ reason: "binding" });
    const changedBinding =
      profile === null ||
      !DeliveryService.sameFolder(job.workspace, profile.repositories.planningTarget, platform) ||
      job.seats.length !== 4 ||
      profile.nativeSeats.length !== 4 ||
      !["lead", ...roles].every((id) => {
        const seat = job.seats.find((seat) => seat.id === id);
        const configured = profile.nativeSeats.find((seat) => seat.id === id);
        return seat !== undefined && configured !== undefined && sameSeat(seat, configured);
      });
    if (terminal(job.state) || (job.owner !== null && job.owner !== owner)) return;
    const admissionId = `${job.id}:${job.generation}`;
    const threadId = ThreadId.make(`engine:${admissionId}`);
    const endpoint = `/api/native-intakes/${job.id}`;
    const post = (action: string, body: unknown) =>
      safe(delivery.nativeIntakeAct({ path: `${endpoint}/${action}`, body })).pipe(
        Effect.flatMap((response) => safe(decodeJob(response.body))),
      );
    if (job.native !== null && job.native.threadId !== threadId)
      return yield* new NativeIntakeError({ reason: "receipt" });
    if (job.owner === null && (!enabled || job.cancelRequested)) return;
    if (changedBinding) {
      if (job.owner === null) return yield* new NativeIntakeError({ reason: "binding" });
      job = yield* post("cancel", { owner });
    }
    if (job.owner === null) job = yield* post("claim", { owner, threadId });
    if (job.owner !== owner || terminal(job.state)) return;
    if (
      job.cancelRequested &&
      job.native === null &&
      !(yield* threads.hasReceipt(CommandId.make(`${admissionId}:start`)))
    ) {
      yield* post("abandon", { owner, threadId, reason: "Cancelled before native admission." });
      return;
    }
    const lead = job.seats.find((seat) => seat.id === "lead")!;
    const modelSelection = yield* safe(selection(lead));
    const seatInstructions = yield* safe(encodeSeats(job.seats));
    // These command receipts survive an HTTP response loss between dispatch and attach.
    if (job.native === null) {
      yield* Effect.gen(function* () {
        yield* safe(
          threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${admissionId}:thread`),
            threadId,
            projectId,
            title: "PayoutLab Discord intake",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: job.workspace,
            createdBy: "system",
            creationSource: "server",
            engineIntake: admissionId,
          }),
        );
        const result = yield* safe(
          threads.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${admissionId}:start`),
            threadId,
            messageId: MessageId.make(`${admissionId}:message`),
            attachments: [],
            createdBy: "system",
            creationSource: "server",
            dispatchMode: { type: "start_immediately" },
            text: `${job.prompt}\n\nNative execution contract: this is engine-owned background planning, not a user conversation. Never publish, claim or release intake evidence yourself. The engine owns those operations. Return only final report JSON. Read the bound profile instructions. Discover native orchestrator capabilities and use precisely these seats: ${seatInstructions}. No model substitutions. Delegate reproduction and data-infrastructure first; await both results before starting independent-verifier. Prefix EACH task prompt with [native-intake:${job.id}:SEAT_ID] using its exact seat ID. The verifier must independently inspect the evidence and both specialist results. Do not delegate any further roles or let specialists delegate. Preserve failures and dissent. The server validates actual child receipts, models, options and ordering before accepting your report. Stop with a concise blocker if any required provider is unavailable. Only isolated reproduction fixtures may be written. No product implementation, board changes, production changes, customer messages or deployments.`,
          }),
        );
        const created = result.storedEvents.find((event) => event.event.type === "run.created");
        if (created?.event.type !== "run.created")
          return yield* new NativeIntakeError({ reason: "receipt" });
        job = yield* post("attach", { owner, threadId, runId: created.event.payload.id });
      }).pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            if (yield* threads.hasReceipt(CommandId.make(`${admissionId}:start`))) return;
            yield* post("cancel", { owner, reason: "Native provider admission failed." });
            yield* post("abandon", {
              owner,
              threadId,
              reason: "Native provider admission failed before a run was accepted.",
            });
          }),
        ),
      );
    }
    if (job.native === null) return yield* new NativeIntakeError({ reason: "receipt" });
    if (job.cancelRequested) {
      yield* safe(
        threads.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`${admissionId}:stop`),
          threadId,
        }),
      );
    }
    const projection = yield* safe(
      projections.getThreadRecords(threadId, ["runs", "subagents", "messages", "runtimeRequests"]),
    );
    if (projection.thread.lineage.engineIntake !== admissionId)
      return yield* new NativeIntakeError({ reason: "receipt" });
    if (
      !job.cancelRequested &&
      projection.runtimeRequests.some((request) => request.status === "pending")
    ) {
      yield* post("cancel", {
        owner,
        reason:
          "The native coordinator requires owner input. Its evidence remains in the native history.",
      });
      yield* safe(
        threads.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`${admissionId}:stop`),
          threadId,
        }),
      );
      return;
    }
    if (
      projection.runs.some(
        (run) => ThreadManagementService.isActiveRun(run) || run.status === "queued",
      ) ||
      projection.subagents.some((task) => !terminal(task.status))
    )
      return;
    const latest = projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
    if (latest === undefined) return yield* new NativeIntakeError({ reason: "receipt" });
    let reason: string | undefined;
    if (latest.status !== "completed") reason = "The native coordinator did not complete.";
    if (
      !modelSelectionsEqual(projection.thread.modelSelection, modelSelection) ||
      projection.runs.some((run) => !modelSelectionsEqual(run.modelSelection, modelSelection))
    )
      reason = "The native lead changed its configured model or options.";
    if (projection.subagents.length !== roles.length)
      reason = "The native team did not use exactly its three specialist seats.";
    const completed = new Map<string, number>();
    for (const role of roles) {
      const tasks = projection.subagents.filter((task) =>
        task.prompt.startsWith(`[native-intake:${job.id}:${role}]`),
      );
      const task = tasks[0];
      const seat = job.seats.find((seat) => seat.id === role)!;
      if (
        tasks.length !== 1 ||
        task === undefined ||
        task.status !== "completed" ||
        task.childThreadId === null ||
        task.startedAt === null ||
        task.completedAt === null
      ) {
        reason = `Missing successful native ${role} receipt.`;
        break;
      }
      const child = yield* safe(
        projections.getThreadRecords(task.childThreadId, ["runs", "subagents"]),
      );
      const expected = yield* safe(selection(seat));
      const actual = child.thread.modelSelection;
      if (
        !modelSelectionsEqual(actual, expected) ||
        child.subagents.length > 0 ||
        child.runs.some((run) => !modelSelectionsEqual(run.modelSelection, expected))
      ) {
        reason = `Native ${role} used a different configuration.`;
        break;
      }
      if (
        role === "independent-verifier" &&
        DateTime.toEpochMillis(task.startedAt) < Math.max(...completed.values())
      ) {
        reason = "Independent verification started before specialist completion.";
        break;
      }
      completed.set(role, DateTime.toEpochMillis(task.completedAt));
    }
    const text =
      projection.messages
        .filter(
          (message) =>
            message.role === "assistant" && message.runId === latest.id && !message.streaming,
        )
        .at(-1)?.text ?? "";
    if (!text.trim()) reason = "The native coordinator returned no report.";
    yield* post("complete", {
      owner,
      threadId,
      runId: job.native.runId,
      state: job.cancelRequested ? "cancelled" : reason === undefined ? "completed" : "failed",
      text,
      ...(reason === undefined ? {} : { reason }),
    });
  });

  const reconcile = Effect.fn("NativeIntake.reconcile")(
    function* () {
      const config = (yield* safe(settings.getSettings)).delivery;
      const optIn = config.nativeIntake;
      if (!config.enabled || optIn === undefined) return;
      const profile = yield* fs.readFileString(optIn.profilePath).pipe(
        Effect.flatMap(decodeProfile),
        Effect.orElseSucceed(() => null),
      );
      const pending = yield* safe(delivery.read({ path: "/api/native-intakes" })).pipe(
        Effect.flatMap((response) => safe(decodePending(response.body))),
      );
      for (const item of pending.pending) {
        if (!/^intake-[a-f0-9]{64}$/.test(item.id))
          return yield* new NativeIntakeError({ reason: "binding" });
        const job = yield* safe(delivery.read({ path: `/api/native-intakes/${item.id}` })).pipe(
          Effect.flatMap((response) => safe(decodeJob(response.body))),
        );
        yield* reconcileJob(
          job,
          profile,
          optIn.projectId,
          optIn.profilePath,
          optIn.enabled && pending.enabled,
        );
      }
    },
    (effect) => lock.withPermits(1)(effect),
  );
  const attempt = reconcile().pipe(
    Effect.catchCause(() =>
      Effect.logWarning(
        "Native Discord intake reconciliation failed; the engine retains its pending receipt.",
      ),
    ),
  );
  const start = Effect.fn("NativeIntake.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.threadId.startsWith("engine:intake-") &&
        (event.type === "run.updated" || event.type === "subagent.updated") &&
        terminal(event.payload.status)
          ? attempt
          : Effect.void,
      ),
    );
    // Discovery and restart catch-up are deterministic. Native completion advances through events.
    yield* forkParked(attempt.pipe(Effect.repeat(Schedule.spaced("30 seconds"))));
  });
  return NativeIntake.of({ reconcile, start });
});

export const layer = Layer.effect(NativeIntake, make);
