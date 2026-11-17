// The engine owns delivery decisions; persist bindings so engine downtime does not erase them.
// Refuse to start if a binding cannot be read, saved, set up, or matched to its session.
import {
  DELIVERY_HARNESS_BY_DRIVER,
  DeliveryError,
  DeliveryOrchestrationConfig,
  DeliveryRememberedLineup,
  DeliveryThreadBinding,
  DeliveryThreadPending,
  DeliveryDiscoveryInput,
  type DeliveryDiscoverySnapshot,
  type DeliveryDiscoveryDiagnostic,
  type DeliveryActInput,
  type DeliveryBindThreadInput,
  type DeliveryReadInput,
  type DeliverySetThreadLineupInput,
  type DeliveryResponse,
  type DeliveryThreadState,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpIncomingMessage } from "effect/http";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import type * as DeliveryEffective from "./DeliveryEffective.ts";
import * as DeliveryThreadSession from "./DeliveryThreadSession.ts";
import * as Discovery from "./deliveryDiscovery.ts";

const BindingsFile = Schema.fromJsonString(
  Schema.Struct({
    threads: Schema.Record(Schema.String, DeliveryThreadBinding),
    pending: Schema.optional(Schema.Record(Schema.String, DeliveryThreadPending)),
    // Null is a conversation that was a team discussion and went back to an ordinary one.
    lineups: Schema.optional(
      Schema.Record(Schema.String, Schema.NullOr(DeliveryOrchestrationConfig)),
    ),
    // The team a conversation switched away from, kept so one click brings it back.
    rememberedLineups: Schema.optional(Schema.Record(Schema.String, DeliveryRememberedLineup)),
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
const decodeDiscoveryInput = Schema.decodeEffect(DeliveryDiscoveryInput);
const decodeDeliveryRequest = Schema.decodeUnknownEffect(
  Schema.Struct({
    route: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/)),
    task: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/))),
    team: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/))),
  }),
);

/** Two spellings of one folder compare equal: slashes, case on Windows, a trailing slash. */
const normalFolder = (value: string, platform: NodeJS.Platform) => {
  const slashed = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
};

export function sameFolder(a: string, b: string, platform: NodeJS.Platform): boolean {
  return normalFolder(a, platform) === normalFolder(b, platform);
}

/** Whether `folder` lies below `parent`. */
function insideFolder(folder: string, parent: string, platform: NodeJS.Platform): boolean {
  return normalFolder(folder, platform).startsWith(`${normalFolder(parent, platform)}/`);
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
    readonly discover: (
      input: DeliveryDiscoveryInput,
      caller: Discovery.DiscoveryCaller,
    ) => Effect.Effect<DeliveryDiscoverySnapshot>;
    readonly act: (input: DeliveryActInput) => Effect.Effect<DeliveryResponse, DeliveryError>;
    /** Internal coordinator writes. Never expose this method as a generic client relay. */
    readonly nativeBuildAct: (
      input: DeliveryActInput,
    ) => Effect.Effect<DeliveryResponse, DeliveryError>;
    readonly nativeIntakeAct: (
      input: DeliveryActInput,
    ) => Effect.Effect<DeliveryResponse, DeliveryError>;
    readonly bindThread: (
      input: DeliveryBindThreadInput,
    ) => Effect.Effect<DeliveryThreadBinding, DeliveryError>;
    readonly refreshThread: (
      threadId: ThreadId,
      configuration: string,
    ) => Effect.Effect<DeliveryThreadBinding, DeliveryError>;
    readonly threadState: (threadId: ThreadId) => Effect.Effect<DeliveryThreadState, DeliveryError>;
    /** Gives up a team choice whose setup never completed. A bound thread cannot be released. */
    readonly releaseThread: (
      threadId: ThreadId,
    ) => Effect.Effect<DeliveryThreadState, DeliveryError>;
    /** Replaces who joins a conversation from its next message on; null makes it an ordinary one. */
    readonly setThreadLineup: (
      input: DeliverySetThreadLineupInput,
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
    discover: Effect.fn("DeliveryService.discover")(function* (input, caller) {
      return {
        ...Discovery.emptyDiscovery(
          input,
          caller,
          "disabled",
          DateTime.formatIso(yield* DateTime.now),
          null,
        ),
        diagnostics: ["disabled" as const],
      };
    }),
    act: disabled,
    nativeBuildAct: disabled,
    nativeIntakeAct: disabled,
    bindThread: disabled,
    refreshThread: disabled,
    threadState: Effect.fn("DeliveryService.threadState")(() =>
      Effect.succeed({ binding: null, pending: null }),
    ),
    releaseThread: Effect.fn("DeliveryService.releaseThread")(() =>
      Effect.succeed({ binding: null, pending: null }),
    ),
    setThreadLineup: disabled,
    prepareThread: Effect.fn("DeliveryService.prepareThread")(() => Effect.succeed(false)),
    terminalEntryScript: Effect.succeed(null),
  }),
);

const make = Effect.fn("DeliveryService.make")(function* (
  deriveConfigMap: typeof deriveProviderInstanceConfigMap,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;

  const bindingsPath = path.join(config.stateDir, "delivery-threads.json");
  const bindings = new Map<string, DeliveryThreadBinding>();
  const pending = new Map<string, DeliveryThreadPending>();
  const lineups = new Map<string, DeliveryOrchestrationConfig | null>();
  const rememberedLineups = new Map<string, DeliveryRememberedLineup>();
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
      for (const [threadId, lineup] of Object.entries(decoded.success.lineups ?? {})) {
        lineups.set(threadId, lineup);
      }
      for (const [threadId, remembered] of Object.entries(
        decoded.success.rememberedLineups ?? {},
      )) {
        rememberedLineups.set(threadId, remembered);
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
        ...(lineups.size > 0 ? { lineups: Object.fromEntries(lineups) } : {}),
        ...(rememberedLineups.size > 0
          ? { rememberedLineups: Object.fromEntries(rememberedLineups) }
          : {}),
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

  const discoveryCache = new Map<
    string,
    { until: number; read: Effect.Effect<DeliveryResponse, DeliveryError> }
  >();
  const discoveryLock = yield* Semaphore.make(1);
  let discoveryGeneration = 0;
  let discoveryConfiguration = "";
  const invalidateDiscovery = () => {
    discoveryGeneration++;
    discoveryCache.clear();
  };

  const readHealth = Effect.fn("DeliveryService.readHealth")(
    function* (engineUrl: string, bounded: boolean) {
      let response = yield* httpClient.execute(
        HttpClientRequest.get(
          new URL(bounded ? "/api/health?identity=1" : "/api/health", engineUrl).toString(),
        ),
      );
      // Older engines may reject the identity query; fallback shares the same deadline.
      if (bounded && (response.status === 400 || response.status === 404)) {
        response = yield* httpClient.execute(
          HttpClientRequest.get(new URL("/api/health", engineUrl).toString()),
        );
      }
      if (bounded && (response.status === 401 || response.status === 403)) {
        return yield* new DeliveryError({
          reason: "refused",
          status: response.status,
          detail: "Engine identity check was not authorized.",
        });
      }
      if (bounded && Number(response.headers["content-length"]) > 1_048_576) {
        return yield* new DeliveryError({
          reason: "invalid",
          status: 413,
          detail: "Discovery response exceeds its size limit.",
        });
      }
      if (response.status !== 200) {
        return yield* new DeliveryError({
          reason: "invalid",
          detail: bounded
            ? "The engine identity check was refused."
            : `The engine at ${engineUrl} answered /api/health with HTTP ${response.status}. No task data was requested or changed.`,
        });
      }
      const body = yield* (
        bounded
          ? response.json.pipe(
              Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(1_048_576)),
            )
          : response.json
      ).pipe(
        Effect.mapError(
          () =>
            new DeliveryError({
              reason: "invalid",
              detail: bounded
                ? "The engine identity response is incompatible."
                : `The endpoint at ${engineUrl} did not answer /api/health as a delivery engine (expected engine "delivery", ok true, profile and home). No task data was requested or changed.`,
            }),
        ),
      );
      return { body, readAt: DateTime.formatIso(yield* DateTime.now) } satisfies DeliveryResponse;
    },
    (effect, _engineUrl, bounded) =>
      effect.pipe(
        Effect.timeout(bounded ? "4 seconds" : "30 seconds"),
        Effect.mapError((error) =>
          error._tag === "DeliveryError"
            ? error
            : new DeliveryError({
                reason: "unreachable",
                detail: "The profile's bound engine did not answer its identity check.",
              }),
        ),
      ),
  );

  const request = Effect.fn("DeliveryService.request")(
    function* (
      method: "GET" | "POST",
      enginePath: string,
      body?: unknown,
      bounded = false,
      observedHealth?: { engineUrl: string; response: DeliveryResponse },
    ) {
      const settings = yield* delivery;
      if (method === "POST") invalidateDiscovery();
      const hostEnvironment = yield* HostProcess.Environment;
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
          reason: bounded ? "mismatch" : "invalid",
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
        // A bound profile needs T3's own side of the identity before the engine is asked for its.
        // Saying which variable is missing beats a generic refusal: both halves come from the same
        // profile launcher, and a half-set launcher is the common way to land here.
        if (!hostEnvironment.POLYMANIA_ACCOUNTS || !hostEnvironment.T3_WORKSPACE_ENGINE_HOME) {
          const missing = [
            ...(hostEnvironment.POLYMANIA_ACCOUNTS ? [] : ["POLYMANIA_ACCOUNTS"]),
            ...(hostEnvironment.T3_WORKSPACE_ENGINE_HOME ? [] : ["T3_WORKSPACE_ENGINE_HOME"]),
          ].join(" and ");
          return yield* new DeliveryError({
            reason: bounded ? "mismatch" : "invalid",
            detail: bounded
              ? "The workspace profile identity is incomplete."
              : `This T3 runs workspace profile '${hostEnvironment.T3_WORKSPACE_PROFILE_ID}' but was started without ${missing}, so it cannot verify its engine. Start T3 through the profile launcher that sets them.`,
          });
        }
        const expectedProfile = hostEnvironment.POLYMANIA_ACCOUNTS;
        const expectedHome = hostEnvironment.T3_WORKSPACE_ENGINE_HOME;
        const healthResponse =
          observedHealth?.engineUrl === settings.engineUrl
            ? observedHealth.response
            : yield* readHealth(settings.engineUrl, bounded);
        const health = yield* Effect.succeed(healthResponse.body).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                engine: Schema.Literal("delivery"),
                ok: Schema.Literal(true),
                // null is how the engine reports "POLYMANIA_ACCOUNTS was not set": a distinct, common
                // failure that deserves its own message rather than a decode error.
                profile: Schema.NullOr(Schema.String),
                home: Schema.String,
              }),
            ),
          ),
          Effect.mapError(
            () =>
              new DeliveryError({
                reason: "invalid",
                detail: bounded
                  ? "The engine identity response is incompatible."
                  : `The endpoint at ${settings.engineUrl} did not answer /api/health as a delivery engine (expected engine "delivery", ok true, profile and home). No task data was requested or changed.`,
              }),
          ),
        );
        if (health.profile === null) {
          return yield* new DeliveryError({
            reason: bounded ? "mismatch" : "invalid",
            detail: bounded
              ? "The engine profile identity is missing."
              : `The engine at ${settings.engineUrl} is running without POLYMANIA_ACCOUNTS (its health reports profile null); this T3 expects profile '${expectedProfile}'. Start the engine through the same profile launcher. No task data was requested or changed.`,
          });
        }
        if (health.profile !== expectedProfile || health.home !== expectedHome) {
          const differences = [
            ...(health.profile === expectedProfile
              ? []
              : [`profile '${health.profile}' (expected '${expectedProfile}')`]),
            ...(health.home === expectedHome
              ? []
              : [`home '${health.home}' (expected '${expectedHome}')`]),
          ].join(", ");
          return yield* new DeliveryError({
            reason: bounded ? "mismatch" : "invalid",
            detail: bounded
              ? "The engine belongs to another workspace profile."
              : `The engine at ${settings.engineUrl} belongs to another account profile or engine home: ${differences}. No task data was requested or changed.`,
          });
        }
        if (bounded && method === "GET" && enginePath === "/api/health") return healthResponse;
      }
      if (bounded && method === "GET" && enginePath === "/api/health") {
        return yield* readHealth(settings.engineUrl, true);
      }
      const base = method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url);
      const prepared =
        method === "GET" ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(body ?? {}));
      const response = yield* httpClient.execute(prepared).pipe(
        Effect.timeout(bounded ? "4 seconds" : "30 seconds"),
        Effect.mapError(
          () =>
            new DeliveryError({
              reason: "unreachable",
              detail: bounded
                ? "The delivery engine did not answer."
                : `The delivery engine did not answer at ${settings.engineUrl}.`,
            }),
        ),
      );
      if (bounded && Number(response.headers["content-length"]) > 1_048_576) {
        return yield* new DeliveryError({
          reason: "invalid",
          status: 413,
          detail: "Discovery response exceeds its size limit.",
        });
      }
      const parsed = yield* (
        bounded
          ? response.json.pipe(
              Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(1_048_576)),
            )
          : response.json
      ).pipe(
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
          detail: bounded
            ? "The engine refused a discovery read."
            : (refusal._tag === "Some" ? refusal.value.error : `HTTP ${response.status}`).slice(
                0,
                500,
              ),
          status: response.status,
          ...(bounded ? {} : { body: parsed }),
        });
      }
      const readAt = DateTime.formatIso(yield* DateTime.now);
      return { readAt, body: parsed } satisfies DeliveryResponse;
    },
    (effect, method) =>
      method === "POST" ? effect.pipe(Effect.ensuring(Effect.sync(invalidateDiscovery))) : effect,
  );

  /** The root of the repository a folder is in, or the folder itself when it is in none. */
  /** The root of the repository a folder is in, or `null` for a folder in none. */
  const repositoryRootOf = Effect.fn("DeliveryService.repositoryRootOf")(function* (
    folder: string,
  ) {
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
    return repository.readable && repository.root ? repository.root : null;
  });

  const workspaceOf = Effect.fn("DeliveryService.workspaceOf")(function* (folder: string) {
    return (yield* repositoryRootOf(folder)) ?? folder;
  });

  const stateOf = (threadId: ThreadId): DeliveryThreadState => {
    const binding = bindings.get(threadId) ?? null;
    // What the thread was started with stands until a person changes it.
    const lineup = lineups.has(threadId) ? lineups.get(threadId) : binding?.orchestration;
    const rememberedLineup = rememberedLineups.get(threadId);
    return {
      binding,
      pending: pending.get(threadId) ?? null,
      ...(lineup ? { lineup } : {}),
      ...(rememberedLineup ? { rememberedLineup } : {}),
    };
  };

  const checkParticipants = (participants: DeliveryOrchestrationConfig["participants"]) =>
    participants.length < 2 ||
    participants.length > 12 ||
    // Two seats may run the same model: a team's roles differ, not only its models.
    new Set(participants.map((seat) => seat.seat)).size !== participants.length
      ? Effect.fail(
          new DeliveryError({
            reason: "invalid",
            detail: "Choose between two and twelve participants for the team discussion.",
          }),
        )
      : Effect.void;

  const setThreadLineup = Effect.fn("DeliveryService.setThreadLineup")(function* (
    input: DeliverySetThreadLineupInput,
  ) {
    yield* storeReadable;
    if (input.orchestration !== null) yield* checkParticipants(input.orchestration.participants);
    const had = lineups.has(input.threadId);
    const previous = lineups.get(input.threadId);
    const hadRemembered = rememberedLineups.has(input.threadId);
    const previousRemembered = rememberedLineups.get(input.threadId);
    lineups.set(input.threadId, input.orchestration);
    if (input.orchestration === null) {
      // Leaving a team keeps it on record, lead model included, so switching back
      // restores exactly what was on. With nothing in force the memory stands.
      const inForce = had
        ? (previous ?? null)
        : (bindings.get(input.threadId)?.orchestration ?? null);
      if (inForce) {
        rememberedLineups.set(input.threadId, {
          orchestration: inForce,
          ...(input.rememberLeadModelSelection
            ? { leadModelSelection: input.rememberLeadModelSelection }
            : {}),
        });
      }
    } else {
      rememberedLineups.delete(input.threadId);
    }
    yield* persist.pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          if (had) lineups.set(input.threadId, previous ?? null);
          else lineups.delete(input.threadId);
          if (hadRemembered && previousRemembered) {
            rememberedLineups.set(input.threadId, previousRemembered);
          } else {
            rememberedLineups.delete(input.threadId);
          }
        }),
      ),
    );
    return stateOf(input.threadId);
  });

  const bindThread = Effect.fn("DeliveryService.bindThread")(function* (
    input: DeliveryBindThreadInput,
    configuration?: string,
  ) {
    yield* storeReadable;
    if (input.orchestration !== undefined) {
      yield* checkParticipants(input.orchestration.participants);
    }
    const existing = bindings.get(input.threadId);
    if (existing) {
      const same =
        existing.team === input.team &&
        existing.driver === input.driver &&
        (existing.orchestration === undefined
          ? input.orchestration === undefined
          : input.orchestration !== undefined &&
            existing.orchestration.participants.length ===
              input.orchestration.participants.length &&
            existing.orchestration.participants.every((seat, index) => {
              const other = input.orchestration!.participants[index]!;
              return (
                seat.seat === other.seat &&
                seat.role === other.role &&
                modelSelectionsEqual(seat.modelSelection, other.modelSelection)
              );
            })) &&
        (input.role === undefined || existing.role === input.role);
      if (same && (configuration === undefined || configuration === existing.configuration))
        return existing;
      if (!same)
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
      ...(input.orchestration === undefined ? {} : { orchestration: input.orchestration }),
      since,
      why: null,
    }).pipe(
      Effect.mapError(
        () => new DeliveryError({ reason: "invalid", detail: "The team choice is not complete." }),
      ),
    );
    if (!existing) {
      pending.set(input.threadId, intent);
      yield* persist.pipe(Effect.tapError(() => Effect.sync(() => pending.delete(input.threadId))));
    }

    const held = Effect.fn("held")(function* (error: DeliveryError) {
      if (existing) return yield* error;
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
      ...(existing ? { handoffFrom: existing.session } : {}),
      ...(input.role ? { role: input.role } : {}),
    }).pipe(Effect.catch(held));
    const workspace = yield* workspaceOf(input.cwd).pipe(Effect.catch(held));
    const binding = yield* decodeOpened(opened.body).pipe(
      Effect.flatMap(({ identity }) =>
        decodeBinding({
          threadId: input.threadId,
          ...(input.orchestration === undefined ? {} : { orchestration: input.orchestration }),
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

    if (configuration !== undefined && binding.configuration !== configuration) {
      return yield* held(
        new DeliveryError({
          reason: "mismatch",
          detail:
            "The team setup changed again while preparing this turn. Send again to retry in this conversation.",
        }),
      );
    }
    bindings.set(input.threadId, binding);
    pending.delete(input.threadId);
    yield* persist.pipe(
      // What is not on disk is not bound: the thread stays held.
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (existing) {
            bindings.set(input.threadId, existing);
            return;
          }
          bindings.delete(input.threadId);
          pending.set(input.threadId, { ...intent, why: error.detail });
        }),
      ),
    );
    return binding;
  });

  const refreshThread = Effect.fn("DeliveryService.refreshThread")(function* (
    threadId: ThreadId,
    configuration: string,
  ) {
    yield* storeReadable;
    const existing = bindings.get(threadId);
    if (!existing)
      return yield* new DeliveryError({
        reason: "refused",
        detail: "This thread has no team setup to refresh.",
      });
    return yield* bindThread(
      {
        threadId,
        team: existing.team,
        role: existing.role,
        driver: existing.driver,
        cwd: existing.project,
        ...(existing.orchestration === undefined ? {} : { orchestration: existing.orchestration }),
      },
      configuration,
    );
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

  const hostPlatform = yield* HostProcess.Platform;

  const discoveryRead = Effect.fn("DeliveryService.discoveryRead")(function* (
    configuration: string,
    enginePath: string,
    observedHealth?: { engineUrl: string; response: DeliveryResponse },
  ) {
    const key = `${configuration}:${enginePath}`;
    const read = yield* discoveryLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cached = discoveryCache.get(key);
        if (cached && cached.until > now) return cached.read;
        const endpoint = request("GET", enginePath, undefined, true, observedHealth);
        const compatible =
          enginePath === "/api/repositories?discovery=1"
            ? endpoint.pipe(
                Effect.catchTags({
                  DeliveryError: (error) =>
                    error.status === 400 || error.status === 404
                      ? request("GET", "/api/repositories", undefined, true, observedHealth)
                      : Effect.fail(error),
                }),
                Effect.timeout("2 seconds"),
                Effect.catchTags({
                  TimeoutError: () =>
                    Effect.fail(
                      new DeliveryError({
                        reason: "unreachable",
                        detail: "The delivery engine did not answer.",
                      }),
                    ),
                }),
              )
            : endpoint;
        const shared: Effect.Effect<DeliveryResponse, DeliveryError> = yield* Effect.cached(
          compatible.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                if (discoveryCache.get(key)?.read === shared) discoveryCache.delete(key);
              }),
            ),
          ),
        );
        if (discoveryCache.size >= 64) discoveryCache.delete(discoveryCache.keys().next().value!);
        discoveryCache.set(key, { until: now + 10_000, read: shared });
        return shared;
      }),
    );
    return yield* read;
  });
  const discover = Effect.fn("DeliveryService.discover")(function* (
    input: DeliveryDiscoveryInput,
    suppliedCaller: Discovery.DiscoveryCaller,
  ): Effect.fn.Return<DeliveryDiscoverySnapshot> {
    const providerDriver =
      suppliedCaller.providerInstanceId === undefined
        ? undefined
        : yield* settingsService.getSettings.pipe(
            Effect.map(
              (settings) => deriveConfigMap(settings)[suppliedCaller.providerInstanceId!]?.driver,
            ),
            Effect.orElseSucceed(() => undefined),
          );
    const driver = suppliedCaller.driver ?? providerDriver;
    const caller = { ...suppliedCaller, ...(driver === undefined ? {} : { driver }) };
    const settings = yield* delivery;
    const environment = yield* HostProcess.Environment;
    const configurationKey = (enabled: boolean, url: string) =>
      JSON.stringify([
        enabled,
        url,
        environment.T3_WORKSPACE_PROFILE_ID,
        environment.POLYMANIA_ACCOUNTS,
        environment.T3_WORKSPACE_ENGINE_HOME,
        environment.T3_WORKSPACE_ENGINE_URL,
      ]);
    const key = configurationKey(settings.enabled, settings.engineUrl);
    if (key !== discoveryConfiguration) {
      discoveryConfiguration = key;
      invalidateDiscovery();
    }
    const generation = discoveryGeneration;
    const configuration = `local:${generation}`;
    const snapshot = Discovery.emptyDiscovery(
      input,
      caller,
      configuration,
      DateTime.formatIso(yield* DateTime.now),
      environment.T3_WORKSPACE_PROFILE_ID ?? null,
    );
    const valid = yield* decodeDiscoveryInput(input).pipe(Effect.result);
    if (suppliedCaller.authorized === false)
      return {
        ...Discovery.emptyDiscovery(
          input,
          { environmentId: caller.environmentId },
          "unavailable",
          snapshot.checkedAt,
          null,
        ),
        diagnostics: ["unauthorized"],
      };
    if (valid._tag === "Failure") return { ...snapshot, diagnostics: ["invalid-request"] };
    if (!settings.enabled) return { ...snapshot, diagnostics: ["disabled"] };
    if (input.fresh || input.preflight) discoveryCache.clear();
    const readTimes: string[] = [];
    let observedHealth: { engineUrl: string; response: DeliveryResponse } | undefined;
    const read = Effect.fn("DeliveryService.discoveryEndpoint")(function* <A>(
      enginePath: string,
      schema: Schema.Decoder<A>,
    ) {
      const response = yield* discoveryRead(configuration, enginePath, observedHealth);
      if (enginePath === "/api/health")
        observedHealth = { engineUrl: settings.engineUrl, response };
      readTimes.push(response.readAt);
      return yield* Schema.decodeUnknownEffect(schema)(response.body).pipe(
        Effect.mapError(
          () =>
            new DeliveryError({
              reason: "invalid",
              detail: "The engine discovery response is incompatible.",
            }),
        ),
      );
    });
    // Allow three round trips without exceeding discovery's ten-second freshness window.
    const result = yield* Effect.gen(function* () {
      const health = yield* read("/api/health", Discovery.DiscoveryHealth);
      if (!health.ok) return { ...snapshot, diagnostics: ["unreachable" as const] };
      const [repository, repositories, teams, data] = yield* Effect.all(
        [
          read(
            `/api/repository?folder=${encodeURIComponent(input.folder)}`,
            Discovery.DiscoveryRepository,
          ),
          input.preflight
            ? read("/api/repositories", Discovery.DiscoveryRepositories).pipe(
                Effect.map((rows) =>
                  rows
                    .filter((row) => row.ok && row.kind === "own")
                    .map((row) => ({ ...row, kind: "own" as const })),
                ),
              )
            : read("/api/repositories?discovery=1", Discovery.DiscoveryRegistrations),
          read("/api/teams", Discovery.DiscoveryTeams),
          read(
            input.task ? `/api/delivery?task=${encodeURIComponent(input.task)}` : "/api/delivery",
            Discovery.DiscoveryDelivery,
          ),
        ],
        { concurrency: 4 },
      );
      const matching = data.boards.filter((board) =>
        repositories.some(
          (repo) =>
            repo.id === board.repository &&
            repository.root !== undefined &&
            sameFolder(repo.path, repository.root, hostPlatform),
        ),
      );
      const selected = input.board
        ? matching.find((board) => board.id === input.board)
        : matching.length === 1
          ? matching[0]
          : undefined;
      let boardDeployment = snapshot.boardDeployment;
      const linkDiagnostics: DeliveryDiscoveryDiagnostic[] = [];
      if (selected && /^[A-Za-z0-9_-]{1,100}$/.test(selected.id)) {
        const link = yield* read(
          `/api/boards/${selected.id}/deployment`,
          Discovery.DiscoveryBoardDeployment,
        ).pipe(Effect.result);
        if (link._tag === "Failure" && (link.failure.status === 401 || link.failure.status === 403))
          linkDiagnostics.push("unauthorized");
        boardDeployment =
          link._tag === "Success"
            ? {
                capability: "available",
                board: Discovery.observationText(selected.id),
                projectId:
                  link.success.deploymentProjectId === null
                    ? null
                    : Discovery.observationText(link.success.deploymentProjectId),
                state: link.success.state,
              }
            : {
                capability:
                  link.failure.reason === "invalid" || link.failure.status === 404
                    ? "unsupported"
                    : "unavailable",
                board: Discovery.observationText(selected.id),
                projectId: null,
                state: null,
              };
      }
      const current = yield* delivery;
      if (
        generation !== discoveryGeneration ||
        key !== configurationKey(current.enabled, current.engineUrl)
      )
        return { ...snapshot, diagnostics: ["configuration-changed" as const] };
      const readAt = readTimes.toSorted()[0]!;
      return Discovery.projectDiscovery(
        input,
        caller,
        {
          ...snapshot,
          diagnostics: linkDiagnostics,
          boardDeployment,
          profile:
            snapshot.profile ??
            (health.profile === null ? null : Discovery.observationText(health.profile)),
          readAt,
          expiresAt: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(readAt), { seconds: 10 })),
        },
        {
          root: repository.readable ? (repository.root ?? null) : null,
          repositories,
          teams,
          delivery: data,
          sameFolder: (a, b) => sameFolder(a, b, hostPlatform),
        },
      );
    }).pipe(Effect.timeout("10 seconds"), Effect.result);
    if (result._tag === "Success") return result.success;
    const error = result.failure;
    const code: DeliveryDiscoveryDiagnostic =
      error._tag === "DeliveryError"
        ? error.status === 401 || error.status === 403
          ? "unauthorized"
          : error.status === 413
            ? "response-too-large"
            : error.reason === "disabled"
              ? "disabled"
              : error.reason === "mismatch"
                ? "profile-mismatch"
                : error.reason === "unreachable"
                  ? "unreachable"
                  : "unsupported-server"
        : error._tag === "TimeoutError"
          ? "unreachable"
          : "unsupported-server";
    return { ...snapshot, diagnostics: [code] };
  });

  const preflightDeliveryRequest = Effect.fn("DeliveryService.preflightDeliveryRequest")(
    function* (body: unknown) {
      const refuse = (code: DeliveryDiscoveryDiagnostic) =>
        new DeliveryError({
          reason: "invalid",
          status: 409,
          detail: `Delivery launch blocked: ${code}. No work was submitted.`,
        });
      const input = yield* decodeDeliveryRequest(body).pipe(
        Effect.mapError(() => refuse("invalid-request")),
      );
      const read = Effect.fn("DeliveryService.launchPreflightRead")(function* <A>(
        path: string,
        schema: Schema.Decoder<A>,
      ) {
        const response = yield* request("GET", path, undefined, true);
        return yield* Schema.decodeEffect(schema)(response.body).pipe(
          Effect.mapError(() => refuse("unsupported-server")),
        );
      });
      const health = yield* read("/api/health", Discovery.DiscoveryHealth);
      if (!health.ok) return yield* refuse("unreachable");
      const data = yield* read("/api/delivery", Discovery.DiscoveryDelivery);
      const route = data.routes.find((item) => item.id === input.route);
      if (!route) return yield* refuse("missing-target");
      const board = data.boards.find((item) => item.id === route.board);
      if (!board?.base || board.repository !== route.repository || board.base !== route.base)
        return yield* refuse("missing-target");
      const project = data.projects.find((item) => item.id === route.project);
      if (!project || project.repository !== route.repository || project.branch !== route.base)
        return yield* refuse("missing-deployment");
      const repositories = yield* read("/api/repositories", Discovery.DiscoveryRepositories);
      if (
        !repositories.some((item) => item.id === route.repository && item.ok && item.kind === "own")
      )
        return yield* refuse("unregistered-repository");
      const task =
        input.task === undefined
          ? undefined
          : yield* read(
              `/api/tasks/${input.task}`,
              Schema.Struct({
                id: Schema.String,
                team: Schema.NullOr(Schema.String),
                repository: Schema.NullOr(Schema.String),
                base: Schema.NullOr(Schema.String),
              }),
            ).pipe(
              Effect.catchTags({
                DeliveryError: (error) =>
                  Effect.fail(error.status === 404 ? refuse("task-not-found") : error),
              }),
            );
      if (
        task &&
        (task.id !== input.task || task.repository !== route.repository || task.base !== route.base)
      )
        return yield* refuse("missing-target");
      const teams = yield* read("/api/teams", Discovery.DiscoveryTeams);
      const team = teams.find((item) => item.team === (task?.team ?? input.team));
      if (!team?.available || !team.takesTasks) return yield* refuse("missing-team");
      if (!team.seats.some((seat) => seat.available && seat.tools.includes("delivery")))
        return yield* refuse("unsupported-provider-tools");
    },
    (effect) =>
      effect.pipe(
        Effect.timeout("3 seconds"),
        Effect.catchTags({
          TimeoutError: () =>
            Effect.fail(
              new DeliveryError({
                reason: "unreachable",
                detail: "Delivery preflight timed out. No work was submitted.",
              }),
            ),
        }),
      ),
  );

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
    const repository = yield* repositoryRootOf(actual.cwd);
    const workspace = repository ?? actual.cwd;
    // A Scratch conversation is bound in the Scratch folder, which is no repository, and
    // then gets a folder of its own below it. That is the same place, not another one.
    const ownFolderBelow =
      repository === null && insideFolder(actual.cwd, binding.workspace, hostPlatform);
    if (!sameFolder(workspace, binding.workspace, hostPlatform) && !ownFolderBelow) {
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
      Effect.sync(() => {
        invalidateDiscovery();
        DeliveryThreadSession.setDeliveryTerminalEntryScript(entryScriptOf(settings.delivery));
      }),
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
    read: Effect.fn("DeliveryService.read")((input) => request("GET", input.path)),
    discover,
    act: Effect.fn("DeliveryService.act")((input) =>
      /^\/api\/native-(builds|intakes)\//.test(
        new URL(input.path, "http://delivery.invalid").pathname,
      )
        ? Effect.fail(
            new DeliveryError({
              reason: "refused",
              detail:
                "Native build receipts can only be written by the server's native coordinator.",
            }),
          )
        : (new URL(input.path, "http://delivery.invalid").pathname === "/api/delivery/requests"
            ? preflightDeliveryRequest(input.body)
            : Effect.void
          ).pipe(Effect.andThen(request("POST", input.path, input.body))),
    ),
    nativeBuildAct: Effect.fn("DeliveryService.nativeBuildAct")((input) =>
      /^\/api\/native-builds\/att-[A-Za-z0-9-]+\/(claim|attach|complete)$/.test(input.path)
        ? request("POST", input.path, input.body)
        : Effect.fail(
            new DeliveryError({
              reason: "invalid",
              detail: "Invalid native coordinator mutation path.",
            }),
          ),
    ),
    nativeIntakeAct: Effect.fn("DeliveryService.nativeIntakeAct")((input) =>
      /^\/api\/native-intakes\/intake-[a-f0-9]{64}\/(claim|attach|complete|abandon|cancel)$/.test(
        input.path,
      )
        ? request("POST", input.path, input.body)
        : Effect.fail(
            new DeliveryError({
              reason: "invalid",
              detail: "Invalid native intake mutation path.",
            }),
          ),
    ),
    bindThread,
    refreshThread,
    threadState: Effect.fn("DeliveryService.threadState")((threadId) =>
      storeReadable.pipe(Effect.as(stateOf(threadId))),
    ),
    releaseThread,
    setThreadLineup,
    prepareThread,
    terminalEntryScript: delivery.pipe(Effect.map(entryScriptOf)),
  });
});

export const layer = (deriveConfigMap: typeof deriveProviderInstanceConfigMap) =>
  Layer.effect(DeliveryService, make(deriveConfigMap));
