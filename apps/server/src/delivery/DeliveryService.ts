/**
 * DeliveryService - relays to a team delivery engine and remembers which
 * threads are bound to a team.
 *
 * The engine owns teams, task flow and approvals. This service decides
 * nothing of that: it relays requests, and it keeps one small record per
 * bound thread so a thread stays bound across restarts even while the engine
 * is down. A bound thread whose team setup cannot be fetched fails to start
 * rather than running as an ordinary thread under a team label.
 *
 * @module DeliveryService
 */
import {
  DELIVERY_HARNESS_BY_DRIVER,
  DeliveryError,
  DeliveryThreadBinding,
  type DeliveryActInput,
  type DeliveryBindThreadInput,
  type DeliveryReadInput,
  type DeliveryResponse,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeliveryThreadSession from "./DeliveryThreadSession.ts";

const BindingsFile = Schema.fromJsonString(
  Schema.Struct({ threads: Schema.Record(Schema.String, DeliveryThreadBinding) }),
);
const decodeBindings = Schema.decodeUnknownEffect(BindingsFile);
const encodeBindings = Schema.encodeEffect(BindingsFile);

const Opened = Schema.Struct({
  identity: Schema.Struct({
    session: Schema.String,
    team: Schema.String,
    role: Schema.String,
    seat: Schema.String,
    harness: Schema.String,
    configuration: Schema.String,
    requestedModel: Schema.optional(Schema.NullOr(Schema.String)),
    memoryScope: Schema.String,
    tools: Schema.Array(Schema.String),
    project: Schema.String,
  }),
});
const decodeOpened = Schema.decodeUnknownEffect(Opened);
const decodeBinding = Schema.decodeUnknownEffect(DeliveryThreadBinding);

const Launch = Schema.Struct({
  instructions: Schema.String,
  instructionsFile: Schema.optional(Schema.String),
  skillFolder: Schema.optional(Schema.NullOr(Schema.String)),
  servers: Schema.Record(
    Schema.String,
    Schema.Struct({
      command: Schema.String,
      args: Schema.Array(Schema.String),
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
});
const decodeLaunch = Schema.decodeUnknownEffect(Launch);

const EngineRefusal = Schema.Struct({ error: Schema.String });
const decodeRefusal = Schema.decodeUnknownOption(EngineRefusal);

export class DeliveryService extends Context.Service<
  DeliveryService,
  {
    readonly read: (input: DeliveryReadInput) => Effect.Effect<DeliveryResponse, DeliveryError>;
    readonly act: (input: DeliveryActInput) => Effect.Effect<DeliveryResponse, DeliveryError>;
    readonly bindThread: (
      input: DeliveryBindThreadInput,
    ) => Effect.Effect<DeliveryThreadBinding, DeliveryError>;
    readonly threadBinding: (threadId: ThreadId) => Effect.Effect<DeliveryThreadBinding | null>;
    /**
     * Fetches a bound thread's team setup and makes it readable by adapters.
     * Succeeds with `false` for an unbound thread, which starts as it always did.
     */
    readonly prepareThread: (threadId: ThreadId) => Effect.Effect<boolean, DeliveryError>;
    /** Settings for terminals T3 Code opens, or null when delivery is off. */
    readonly terminalEntryScript: Effect.Effect<string | null>;
  }
>()("t3/delivery/DeliveryService") {}

/** Inert service, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  DeliveryService,
  DeliveryService.of({
    read: () =>
      Effect.fail(new DeliveryError({ reason: "disabled", detail: "Delivery is turned off." })),
    act: () =>
      Effect.fail(new DeliveryError({ reason: "disabled", detail: "Delivery is turned off." })),
    bindThread: () =>
      Effect.fail(new DeliveryError({ reason: "disabled", detail: "Delivery is turned off." })),
    threadBinding: () => Effect.succeed(null),
    prepareThread: () => Effect.succeed(false),
    terminalEntryScript: Effect.succeed(null),
  }),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;

  const bindingsPath = path.join(config.stateDir, "delivery-threads.json");
  const bindings = new Map<string, DeliveryThreadBinding>();
  const writeLock = yield* Semaphore.make(1);

  // A missing or unreadable file means no thread is bound yet. It is never
  // treated as a reason to drop bindings already in memory.
  yield* fileSystem.readFileString(bindingsPath).pipe(
    Effect.flatMap(decodeBindings),
    Effect.tap((file) =>
      Effect.sync(() => {
        for (const [threadId, binding] of Object.entries(file.threads)) {
          bindings.set(threadId, binding);
        }
      }),
    ),
    Effect.catch(() => Effect.void),
  );

  const persist = writeLock.withPermits(1)(
    // Suspended, so that what is written is what is bound when the write runs.
    Effect.suspend(() => encodeBindings({ threads: Object.fromEntries(bindings) })).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: bindingsPath, contents }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Could not save delivery thread bindings", { cause }),
      ),
    ),
  );

  const delivery = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.delivery),
    Effect.orElseSucceed(() => ({ enabled: false, engineUrl: "", terminalEntryScript: "" })),
  );

  const request = Effect.fn("DeliveryService.request")(function* (
    method: "GET" | "POST",
    enginePath: string,
    body?: unknown,
  ) {
    const settings = yield* delivery;
    if (!settings.enabled) {
      return yield* new DeliveryError({
        reason: "disabled",
        detail: "Delivery is turned off in settings.",
      });
    }
    const url = yield* Effect.try({
      try: () => {
        const base = new URL(settings.engineUrl);
        // The engine holds approvals. It is only ever reached on this host.
        if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
          throw new Error("not loopback");
        }
        return new URL(enginePath, base).toString();
      },
      catch: () =>
        new DeliveryError({
          reason: "invalid",
          detail: "The engine address must be a loopback URL, such as http://127.0.0.1:4320.",
        }),
    });
    const base = method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url);
    const prepared =
      method === "GET" ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(body ?? {}));
    const response = yield* httpClient.execute(prepared).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError(
        () =>
          new DeliveryError({
            reason: "unreachable",
            detail: `The delivery engine did not answer at ${settings.engineUrl}.`,
          }),
      ),
    );
    const parsed = yield* response.json.pipe(
      Effect.mapError(
        () =>
          new DeliveryError({
            reason: "invalid",
            detail: "The delivery engine answered with something that is not JSON.",
            status: response.status,
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      const refusal = decodeRefusal(parsed);
      return yield* new DeliveryError({
        reason: "refused",
        detail: (refusal._tag === "Some" ? refusal.value.error : `HTTP ${response.status}`).slice(
          0,
          500,
        ),
        status: response.status,
        body: parsed,
      });
    }
    const readAt = DateTime.formatIso(yield* DateTime.now);
    return { readAt, body: parsed } satisfies DeliveryResponse;
  });

  const bindThread = Effect.fn("DeliveryService.bindThread")(function* (
    input: DeliveryBindThreadInput,
  ) {
    const existing = bindings.get(input.threadId);
    if (existing) {
      // A thread keeps what it started with. Another team is another thread.
      if (existing.team === input.team) return existing;
      return yield* new DeliveryError({
        reason: "refused",
        detail: `This thread is bound to team ${existing.team}. Start a new thread to work with team ${input.team}.`,
      });
    }
    const harness = DELIVERY_HARNESS_BY_DRIVER[input.driver];
    if (!harness) {
      return yield* new DeliveryError({
        reason: "unsupportedHarness",
        detail: `Teams are not set up for the ${input.driver} harness.`,
      });
    }
    const opened = yield* request("POST", "/api/sessions", {
      team: input.team,
      harness,
      cwd: input.cwd,
      mode: "chat",
      thread: input.threadId,
      ...(input.role ? { role: input.role } : {}),
    });
    const { identity } = yield* decodeOpened(opened.body).pipe(
      Effect.mapError(
        () =>
          new DeliveryError({
            reason: "invalid",
            detail: "The delivery engine opened a session without a usable receipt.",
          }),
      ),
    );
    const binding = yield* decodeBinding({
      threadId: input.threadId,
      session: identity.session,
      team: identity.team,
      role: identity.role,
      seat: identity.seat,
      harness: identity.harness,
      configuration: identity.configuration,
      requestedModel: identity.requestedModel ?? null,
      memoryScope: identity.memoryScope,
      tools: identity.tools,
      project: identity.project,
      boundAt: opened.readAt,
    }).pipe(
      Effect.mapError(
        () =>
          new DeliveryError({
            reason: "invalid",
            detail: "The delivery engine's receipt is missing a field.",
          }),
      ),
    );
    bindings.set(input.threadId, binding);
    yield* persist;
    return binding;
  });

  const prepareThread = Effect.fn("DeliveryService.prepareThread")(function* (threadId: ThreadId) {
    const binding = bindings.get(threadId);
    if (!binding) {
      DeliveryThreadSession.clearDeliveryThreadSession(threadId);
      return false;
    }
    const launch = yield* request("GET", `/api/sessions/${binding.session}/launch`).pipe(
      Effect.flatMap((response) =>
        decodeLaunch(response.body).pipe(
          Effect.mapError(
            () =>
              new DeliveryError({
                reason: "invalid",
                detail: "The delivery engine returned a team setup that cannot be read.",
              }),
          ),
        ),
      ),
    );
    DeliveryThreadSession.setDeliveryThreadSession({
      threadId,
      team: binding.team,
      role: binding.role,
      configuration: binding.configuration,
      instructions: launch.instructions,
      instructionsFile: launch.instructionsFile,
      skillFolder: launch.skillFolder ?? undefined,
      servers: Object.fromEntries(
        Object.entries(launch.servers).map(([name, server]) => [
          name,
          { command: server.command, args: server.args, env: server.env ?? {} },
        ]),
      ),
    });
    return true;
  });

  // Terminals read the entry script without an Effect, so it is kept current here.
  const entryScriptOf = (settings: { enabled: boolean; terminalEntryScript: string }) =>
    settings.enabled && settings.terminalEntryScript ? settings.terminalEntryScript : null;
  DeliveryThreadSession.setDeliveryTerminalEntryScript(entryScriptOf(yield* delivery));
  yield* settingsService.streamChanges.pipe(
    Stream.runForEach((settings) =>
      Effect.sync(() =>
        DeliveryThreadSession.setDeliveryTerminalEntryScript(entryScriptOf(settings.delivery)),
      ),
    ),
    Effect.forkScoped,
  );

  DeliveryThreadSession.registerDeliveryPreparer(prepareThread);
  DeliveryThreadSession.registerDeliveryTeamLookup((threadId) => bindings.get(threadId)?.team);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      DeliveryThreadSession.registerDeliveryPreparer(undefined);
      DeliveryThreadSession.registerDeliveryTeamLookup(undefined);
      DeliveryThreadSession.setDeliveryTerminalEntryScript(null);
      DeliveryThreadSession.clearAllDeliveryThreadSessions();
    }),
  );

  return DeliveryService.of({
    read: (input) => request("GET", input.path),
    act: (input) => request("POST", input.path, input.body),
    bindThread,
    threadBinding: (threadId) => Effect.sync(() => bindings.get(threadId) ?? null),
    prepareThread,
    terminalEntryScript: delivery.pipe(Effect.map(entryScriptOf)),
  });
});

export const layer = Layer.effect(DeliveryService, make);
