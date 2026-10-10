/**
 * DeliveryService - relays to a team delivery engine and remembers which
 * threads are bound to a team.
 *
 * The engine owns teams, task flow and approvals. This service decides
 * nothing of that: it relays requests, and it keeps one small record per
 * bound thread so a thread stays bound across restarts even while the engine
 * is down.
 *
 * Every doubt is resolved against starting. A record that cannot be read, a
 * record that cannot be saved, a team setup that did not complete and a
 * session that does not match what the thread was bound with all stop the
 * session, because the alternative is an ordinary thread under a team's name.
 *
 * @module DeliveryService
 */
import {
  DELIVERY_HARNESS_BY_DRIVER,
  DeliveryError,
  DeliveryThreadBinding,
  DeliveryThreadPending,
  type DeliveryActInput,
  type DeliveryBindThreadInput,
  type DeliveryReadInput,
  type DeliveryResponse,
  type DeliveryThreadState,
  type ThreadId,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as DeliveryEffective from "./DeliveryEffective.ts";
import * as DeliveryThreadSession from "./DeliveryThreadSession.ts";

const BindingsFile = Schema.fromJsonString(
  Schema.Struct({
    threads: Schema.Record(Schema.String, DeliveryThreadBinding),
    pending: Schema.optional(Schema.Record(Schema.String, DeliveryThreadPending)),
  }),
);
const decodeBindings = Schema.decodeUnknownEffect(BindingsFile);
const encodeBindings = Schema.encodeEffect(BindingsFile);

const Identity = Schema.Struct({
  session: Schema.String,
  team: Schema.String,
  role: Schema.String,
  seat: Schema.String,
  harness: Schema.String,
  configuration: Schema.String,
  requestedModel: Schema.optional(Schema.NullOr(Schema.String)),
  seatSettings: Schema.optional(
    Schema.Struct({
      harness: Schema.String,
      model: Schema.NullOr(Schema.String),
      reasoning: Schema.NullOr(Schema.String),
      access: Schema.NullOr(Schema.String),
      from: Schema.String,
    }),
  ),
  memoryScope: Schema.String,
  tools: Schema.Array(Schema.String),
  project: Schema.String,
});
const decodeOpened = Schema.decodeUnknownEffect(Schema.Struct({ identity: Identity }));
const decodeBinding = Schema.decodeUnknownEffect(DeliveryThreadBinding);
const decodePending = Schema.decodeUnknownEffect(DeliveryThreadPending);

const Launch = Schema.Struct({
  identity: Identity,
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

const Repository = Schema.Struct({
  readable: Schema.Boolean,
  root: Schema.optional(Schema.String),
});
const decodeRepository = Schema.decodeUnknownEffect(Repository);

const EngineRefusal = Schema.Struct({ error: Schema.String });
const decodeRefusal = Schema.decodeUnknownOption(EngineRefusal);

/** Two spellings of one folder compare equal: slashes, case on Windows, a trailing slash. */
export function sameFolder(a: string, b: string, platform: NodeJS.Platform): boolean {
  const normal = (value: string) => {
    const slashed = value.replaceAll("\\", "/").replace(/\/+$/, "");
    return platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  return normal(a) === normal(b);
}

/** What a session is really started with, to be held against what the thread was bound with. */
export interface DeliveryActualSession {
  /** T3 Code's driver kind of the provider instance that is starting. */
  readonly driver: string;
  readonly cwd: string | undefined;
}

export class DeliveryService extends Context.Service<
  DeliveryService,
  {
    readonly read: (input: DeliveryReadInput) => Effect.Effect<DeliveryResponse, DeliveryError>;
    readonly act: (input: DeliveryActInput) => Effect.Effect<DeliveryResponse, DeliveryError>;
    readonly bindThread: (
      input: DeliveryBindThreadInput,
    ) => Effect.Effect<DeliveryThreadBinding, DeliveryError>;
    readonly threadState: (threadId: ThreadId) => Effect.Effect<DeliveryThreadState, DeliveryError>;
    /** Gives up a team choice whose setup never completed. A bound thread cannot be released. */
    readonly releaseThread: (
      threadId: ThreadId,
    ) => Effect.Effect<DeliveryThreadState, DeliveryError>;
    /**
     * Fetches a bound thread's team setup and makes it readable by adapters.
     * Succeeds with `false` for a thread with no team, which starts as it
     * always did. Fails for anything in between.
     */
    readonly prepareThread: (
      threadId: ThreadId,
      actual: DeliveryActualSession,
    ) => Effect.Effect<boolean, DeliveryError>;
    /** Settings for terminals T3 Code opens, or null when delivery is off. */
    readonly terminalEntryScript: Effect.Effect<string | null>;
  }
>()("t3/delivery/DeliveryService") {}

const disabled = () =>
  Effect.fail(new DeliveryError({ reason: "disabled", detail: "Delivery is turned off." }));

/** Inert service, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  DeliveryService,
  DeliveryService.of({
    read: disabled,
    act: disabled,
    bindThread: disabled,
    threadState: () => Effect.succeed({ binding: null, pending: null }),
    releaseThread: () => Effect.succeed({ binding: null, pending: null }),
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
  const pending = new Map<string, DeliveryThreadPending>();
  const writeLock = yield* Semaphore.make(1);

  // Only a file that is not there means that no thread is bound. A file that
  // is there and cannot be read or understood holds bindings this service
  // does not know: it is left untouched and every thread is held until a
  // person has looked at it.
  let storeProblem: string | null = null;
  const loaded = yield* fileSystem.readFileString(bindingsPath).pipe(
    Effect.map((contents) => ({ kind: "read" as const, contents })),
    Effect.catch((error) =>
      Effect.succeed(
        error.reason._tag === "NotFound"
          ? { kind: "absent" as const }
          : { kind: "unreadable" as const, why: error.reason._tag },
      ),
    ),
  );
  if (loaded.kind === "unreadable") {
    storeProblem = `The record of team threads at ${bindingsPath} could not be read (${loaded.why}).`;
  } else if (loaded.kind === "read") {
    const decoded = yield* decodeBindings(loaded.contents).pipe(Effect.result);
    if (decoded._tag === "Failure") {
      storeProblem = `The record of team threads at ${bindingsPath} is damaged and was left as it is.`;
    } else {
      for (const [threadId, binding] of Object.entries(decoded.success.threads)) {
        bindings.set(threadId, binding);
      }
      for (const [threadId, intent] of Object.entries(decoded.success.pending ?? {})) {
        pending.set(threadId, intent);
      }
    }
  }
  if (storeProblem) yield* Effect.logError(storeProblem);

  const storeReadable = Effect.suspend(() =>
    storeProblem
      ? Effect.fail(
          new DeliveryError({
            reason: "storage",
            detail: `${storeProblem} No thread can be started until it is repaired or moved away, because which threads belong to a team is not known.`,
          }),
        )
      : Effect.void,
  );

  const persist = writeLock.withPermits(1)(
    // Suspended, so that what is written is what is bound when the write runs.
    Effect.suspend(() =>
      encodeBindings({
        threads: Object.fromEntries(bindings),
        pending: Object.fromEntries(pending),
      }),
    ).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: bindingsPath, contents }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      ),
      Effect.tapError((cause) =>
        Effect.logError("Could not save delivery thread bindings", { cause }),
      ),
      Effect.mapError(
        () =>
          new DeliveryError({
            reason: "storage",
            detail: `The thread's team could not be saved to ${bindingsPath}, so it would be lost at the next restart. The thread was not started.`,
          }),
      ),
    ),
  );

  const delivery = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.delivery),
    Effect.orElseSucceed(() => ({
      enabled: false,
      engineUrl: "",
      terminalEntryScript: "",
      engineCommand: "",
    })),
  );

  const request = Effect.fn("DeliveryService.request")(function* (
    method: "GET" | "POST",
    enginePath: string,
    body?: unknown,
  ) {
    const settings = yield* delivery;
    const hostEnvironment = yield* HostProcessEnvironment;
    if (!settings.enabled) {
      return yield* new DeliveryError({
        reason: "disabled",
        detail: "Delivery is turned off in settings.",
      });
    }
    if (
      hostEnvironment.T3_WORKSPACE_PROFILE_ID &&
      (!hostEnvironment.T3_WORKSPACE_ENGINE_URL ||
        settings.engineUrl !== hostEnvironment.T3_WORKSPACE_ENGINE_URL)
    ) {
      return yield* new DeliveryError({
        reason: "invalid",
        detail:
          "This account profile's Delivery settings do not match its bound engine endpoint. Correct them in native Settings; no other profile's engine was contacted.",
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
    if (hostEnvironment.T3_WORKSPACE_PROFILE_ID) {
      const healthResponse = yield* httpClient
        .execute(HttpClientRequest.get(new URL("/api/health", settings.engineUrl).toString()))
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError(
            () =>
              new DeliveryError({
                reason: "unreachable",
                detail: "The profile's bound engine did not answer its identity check.",
              }),
          ),
        );
      const health = yield* healthResponse.json.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              engine: Schema.Literal("delivery"),
              ok: Schema.Literal(true),
              profile: Schema.String,
              home: Schema.String,
            }),
          ),
        ),
        Effect.mapError(
          () =>
            new DeliveryError({
              reason: "invalid",
              detail: "The bound endpoint did not provide a verifiable engine identity.",
            }),
        ),
      );
      if (
        healthResponse.status !== 200 ||
        !hostEnvironment.T3_WORKSPACE_ENGINE_HOME ||
        health.profile !== hostEnvironment.POLYMANIA_ACCOUNTS ||
        health.home !== hostEnvironment.T3_WORKSPACE_ENGINE_HOME
      ) {
        return yield* new DeliveryError({
          reason: "invalid",
          detail:
            "The bound endpoint is running another account profile or engine home. No task data was requested or changed.",
        });
      }
    }
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

  /** The root of the repository a folder is in, or the folder itself when it is in none. */
  const workspaceOf = Effect.fn("DeliveryService.workspaceOf")(function* (folder: string) {
    const response = yield* request("GET", `/api/repository?folder=${encodeURIComponent(folder)}`);
    const repository = yield* decodeRepository(response.body).pipe(
      Effect.mapError(
        () =>
          new DeliveryError({
            reason: "invalid",
            detail: "The delivery engine could not describe the working folder.",
          }),
      ),
    );
    return repository.readable && repository.root ? repository.root : folder;
  });

  const stateOf = (threadId: ThreadId): DeliveryThreadState => ({
    binding: bindings.get(threadId) ?? null,
    pending: pending.get(threadId) ?? null,
  });

  const bindThread = Effect.fn("DeliveryService.bindThread")(function* (
    input: DeliveryBindThreadInput,
  ) {
    yield* storeReadable;
    const existing = bindings.get(input.threadId);
    if (existing) {
      // A thread keeps what it started with. Anything else is another thread.
      const same =
        existing.team === input.team &&
        existing.driver === input.driver &&
        (input.role === undefined || existing.role === input.role);
      if (same) return existing;
      return yield* new DeliveryError({
        reason: "refused",
        detail: `This thread is bound to team ${existing.team} as ${existing.role} on ${existing.harness}. Start a new thread to work with another team, role or harness.`,
      });
    }
    const harness = DELIVERY_HARNESS_BY_DRIVER[input.driver];
    if (!harness) {
      return yield* new DeliveryError({
        reason: "unsupportedHarness",
        detail: `Teams are not set up for the ${input.driver} harness.`,
      });
    }

    // The intent is on record before anything can fail, so that a setup that
    // does not complete leaves a held thread behind and not a free one.
    const since = DateTime.formatIso(yield* DateTime.now);
    const intent = yield* decodePending({
      threadId: input.threadId,
      team: input.team,
      role: input.role ?? null,
      driver: input.driver,
      cwd: input.cwd,
      since,
      why: null,
    }).pipe(
      Effect.mapError(
        () => new DeliveryError({ reason: "invalid", detail: "The team choice is not complete." }),
      ),
    );
    pending.set(input.threadId, intent);
    yield* persist.pipe(Effect.tapError(() => Effect.sync(() => pending.delete(input.threadId))));

    const held = (error: DeliveryError) =>
      Effect.gen(function* () {
        pending.set(input.threadId, { ...intent, why: error.detail });
        yield* persist.pipe(Effect.ignore);
        return yield* error;
      });

    const opened = yield* request("POST", "/api/sessions", {
      team: input.team,
      harness,
      cwd: input.cwd,
      mode: "chat",
      thread: input.threadId,
      ...(input.role ? { role: input.role } : {}),
    }).pipe(Effect.catch(held));
    const workspace = yield* workspaceOf(input.cwd).pipe(Effect.catch(held));
    const binding = yield* decodeOpened(opened.body).pipe(
      Effect.flatMap(({ identity }) =>
        decodeBinding({
          threadId: input.threadId,
          session: identity.session,
          team: identity.team,
          role: identity.role,
          seat: identity.seat,
          harness: identity.harness,
          driver: input.driver,
          workspace,
          configuration: identity.configuration,
          requestedModel: identity.requestedModel ?? null,
          ...(identity.seatSettings ? { seatSettings: identity.seatSettings } : {}),
          memoryScope: identity.memoryScope,
          tools: identity.tools,
          project: identity.project,
          boundAt: opened.readAt,
        }),
      ),
      Effect.mapError(
        () =>
          new DeliveryError({
            reason: "invalid",
            detail: "The delivery engine opened a session without a usable receipt.",
          }),
      ),
      Effect.catch(held),
    );
    if (binding.team !== input.team || binding.harness !== harness) {
      return yield* held(
        new DeliveryError({
          reason: "mismatch",
          detail: `The delivery engine opened a session for team ${binding.team} on ${binding.harness}, which is not what was asked for.`,
        }),
      );
    }
    if (input.role !== undefined && binding.role !== input.role) {
      return yield* held(
        new DeliveryError({
          reason: "mismatch",
          detail: `The delivery engine opened the session as ${binding.role}, not as ${input.role}.`,
        }),
      );
    }

    bindings.set(input.threadId, binding);
    pending.delete(input.threadId);
    yield* persist.pipe(
      // What is not on disk is not bound: the thread stays held.
      Effect.tapError((error) =>
        Effect.sync(() => {
          bindings.delete(input.threadId);
          pending.set(input.threadId, { ...intent, why: error.detail });
        }),
      ),
    );
    return binding;
  });

  const releaseThread = Effect.fn("DeliveryService.releaseThread")(function* (threadId: ThreadId) {
    yield* storeReadable;
    if (bindings.has(threadId)) {
      return yield* new DeliveryError({
        reason: "refused",
        detail: "This thread is bound to a team, and a bound thread keeps its team.",
      });
    }
    const intent = pending.get(threadId);
    if (!intent) return stateOf(threadId);
    pending.delete(threadId);
    yield* persist.pipe(Effect.tapError(() => Effect.sync(() => pending.set(threadId, intent))));
    return stateOf(threadId);
  });

  const hostPlatform = yield* HostProcessPlatform;

  const prepareThread = Effect.fn("DeliveryService.prepareThread")(function* (
    threadId: ThreadId,
    actual: DeliveryActualSession,
  ) {
    DeliveryThreadSession.clearDeliveryThreadSession(threadId);
    const settings = yield* delivery;
    // With delivery off nothing was ever bound through this service, and a
    // thread starts as it always did.
    if (!settings.enabled && bindings.size === 0 && pending.size === 0 && !storeProblem) {
      return false;
    }
    yield* storeReadable;
    const intent = pending.get(threadId);
    if (intent && !bindings.has(threadId)) {
      return yield* new DeliveryError({
        reason: "pending",
        detail: `Team ${intent.team} was chosen for this thread and its setup did not complete${intent.why ? `: ${intent.why}` : "."} Send again to retry, or choose "No team" to start it as an ordinary thread.`,
      });
    }
    const binding = bindings.get(threadId);
    if (!binding) return false;

    if (actual.driver !== binding.driver) {
      return yield* new DeliveryError({
        reason: "mismatch",
        detail: `This thread is bound to team ${binding.team} as ${binding.role} on ${binding.driver}. It cannot continue on ${actual.driver}: the role's instructions and tools were set up for the other harness. Switch back, or start a new thread.`,
      });
    }
    if (!actual.cwd) {
      return yield* new DeliveryError({
        reason: "mismatch",
        detail: `This thread is bound to team ${binding.team} in ${binding.workspace}, and the session has no working folder to hold against it.`,
      });
    }
    const workspace = yield* workspaceOf(actual.cwd);
    if (!sameFolder(workspace, binding.workspace, hostPlatform)) {
      return yield* new DeliveryError({
        reason: "mismatch",
        detail: `This thread is bound to team ${binding.team} in ${binding.workspace}. The session is starting in ${workspace}, which is another repository.`,
      });
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
    const given = launch.identity;
    const differs = (
      [
        ["team", given.team, binding.team],
        ["role", given.role, binding.role],
        ["seat", given.seat, binding.seat],
        ["harness", given.harness, binding.harness],
        ["setup", given.configuration, binding.configuration],
      ] as const
    ).filter(([, now, bound]) => now !== bound);
    if (differs.length > 0) {
      return yield* new DeliveryError({
        reason: "mismatch",
        detail: `The delivery engine's setup for this thread is not the one it was bound with: ${differs.map(([name, now, bound]) => `${name} is ${now}, bound as ${bound}`).join("; ")}.`,
      });
    }

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
    DeliveryThreadSession.beginDeliveryEffective(threadId);
    return true;
  });

  // The record is kept by the engine. A report it does not take is logged and
  // does not stop the thread, which runs on what it was given either way.
  const reportEffective = (threadId: ThreadId, report: DeliveryEffective.EffectiveReport) => {
    const binding = bindings.get(threadId);
    if (!binding) return Effect.void;
    return request("POST", `/api/sessions/${binding.session}/effective`, {
      by: "T3 Code",
      ...report,
    }).pipe(
      Effect.asVoid,
      Effect.catch((cause) =>
        Effect.logWarning("Could not record what a team thread ran on", {
          threadId,
          session: binding.session,
          detail: cause.detail,
        }),
      ),
    );
  };

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
  DeliveryThreadSession.registerDeliveryReporter(reportEffective);
  DeliveryThreadSession.registerDeliveryTeamLookup((threadId) => bindings.get(threadId)?.team);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      DeliveryThreadSession.registerDeliveryPreparer(undefined);
      DeliveryThreadSession.registerDeliveryReporter(undefined);
      DeliveryThreadSession.registerDeliveryTeamLookup(undefined);
      DeliveryThreadSession.setDeliveryTerminalEntryScript(null);
      DeliveryThreadSession.clearAllDeliveryThreadSessions();
    }),
  );

  return DeliveryService.of({
    read: (input) => request("GET", input.path),
    act: (input) => request("POST", input.path, input.body),
    bindThread,
    threadState: (threadId) => storeReadable.pipe(Effect.as(stateOf(threadId))),
    releaseThread,
    prepareThread,
    terminalEntryScript: delivery.pipe(Effect.map(entryScriptOf)),
  });
});

export const layer = Layer.effect(DeliveryService, make);
