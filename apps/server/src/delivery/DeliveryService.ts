// The engine owns delivery decisions; persist bindings so engine downtime does not erase them.
// Refuse to start if a binding cannot be read, saved, set up, or matched to its session.
import {
  DELIVERY_HARNESS_BY_DRIVER,
  type DeliveryBoardApprovalKeyStatus,
  DeliveryError,
  DeliveryOrchestrationConfig,
  DeliveryRememberedLineup,
  DeliveryThreadBinding,
  DeliveryThreadLineup,
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
  ThreadId,
  type EnvironmentId,
  LinkedDeliveryRead,
  LinkedHandoffPeerId,
  LINKED_HANDOFF_BUNDLE_MAX_BYTES,
  LinkedHandoffPeerRequest,
  LinkedHandoffPeerResponses,
  LinkedDeliveryAction,
  LinkedDeliveryResults,
  DeliverySetBoardLinkedVisibility,
  DeliverySetTaskLinkedHidden,
  DeliveryBoardLinkedVisibility,
  DeliveryTaskLinkedHidden,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { deliveryFailureDiagnostic } from "@t3tools/shared/deliveryDiagnostics";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpIncomingMessage } from "effect/http";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ServerConfig } from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import type * as DeliveryEffective from "./DeliveryEffective.ts";
import { boardTaskOfMarker } from "./boardThreadMarker.ts";
import * as DeliveryThreadSession from "./DeliveryThreadSession.ts";
import * as Discovery from "./deliveryDiscovery.ts";
import { linkedReturnPeer } from "./linkedReturn.ts";
import { readBoundedBody } from "./readBoundedBody.ts";

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

// Board tasks' lineups, in a file of their own: a build that predates them never reads it, and
// the board can always give them again. Null is a board task's thread with no team to show.
const BoardLineupsFile = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.NullOr(DeliveryThreadLineup)),
);
const decodeBoardLineups = Schema.decodeUnknownEffect(BoardLineupsFile);
const sameBoardLineup = Schema.toEquivalence(Schema.NullOr(DeliveryThreadLineup));
const encodeBoardLineups = Schema.encodeEffect(BoardLineupsFile);

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
const configurationKey = (enabled: boolean, url: string, environment: NodeJS.ProcessEnv) =>
  JSON.stringify([
    enabled,
    url,
    environment.T3_WORKSPACE_PROFILE_ID,
    environment.POLYMANIA_ACCOUNTS,
    environment.T3_WORKSPACE_ENGINE_HOME,
    environment.T3_WORKSPACE_ENGINE_URL,
  ]);

const decodeDiscoveryHealth = Schema.decodeUnknownEffect(Discovery.DiscoveryHealth);
const decodeRepositoryCheck = Schema.decodeUnknownEffect(Discovery.DiscoveryRepositoryCheck);
const decodeDeliveryRequest = Schema.decodeUnknownEffect(
  Schema.Struct({
    route: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/)),
    task: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/))),
    team: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/))),
  }),
);

/**
 * The engine writes for a board task's conversations, its own and its related threads (slice
 * L2t); only the server makes them.
 */
const BOARD_THREAD_LINK = /^\/api\/tasks\/[\w-]+\/(?:board-thread|threads\/[\w-]{1,80})$/;
/** The engine's approval key for server-owned board writes. Wins over the one saved in Settings. */
export const BOARD_THREAD_KEY_VARIABLE = "T3_DELIVERY_BOARD_THREAD_KEY";
/** Where Settings saves the board approval key in the server's secret store. */
export const BOARD_APPROVAL_KEY_SECRET = "delivery-board-approval-key";
export const NO_BOARD_APPROVAL_KEY =
  "This server has no board approval key configured. Set it in Settings → Threads → Board.";

/** The key a keyed board write uses: the server's variable when it is set, else the saved one. */
export function resolveBoardApprovalKey(
  environment: NodeJS.ProcessEnv,
  stored: string | undefined,
): { readonly key: string | undefined; readonly status: DeliveryBoardApprovalKeyStatus } {
  const fromEnvironment = environment[BOARD_THREAD_KEY_VARIABLE];
  const saved = Boolean(stored);
  if (fromEnvironment)
    return { key: fromEnvironment, status: { source: "environment", stored: saved } };
  if (stored) return { key: stored, status: { source: "settings", stored: true } };
  return { key: undefined, status: { source: "none", stored: false } };
}
export const BoardThreadLink = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
  setBy: Schema.String,
  setAt: Schema.String,
});
/** A board field this build may not read: read as `null`, so the task it is on is still handled. */
export const readOrNull = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(schema).pipe(Schema.catchDecoding(() => Effect.succeedSome(null))));
const BOARD_THREAD_CLAIM = /^\/api\/orchestration\/tasks\/[\w-]+\/(claim|ack|release)$/;
// The conversation's mirror and the steer handshake (spec 6a, slice 5).
const BOARD_THREAD_CONVERSATION =
  /^\/api\/tasks\/[\w-]+\/(activity|steers\/\d+\/(delivered|failed))$/;
const BOARD_SEAT_POST =
  /^\/api\/(?:tasks\/[\w-]+\/(?:qa-receipts|lead-pick)|runs\/[\w-]+\/(?:seat-attestations|handoffs(?:\/qa\/(?:delivered|fallback))?))$/;
const BOARD_TASK_POST = /^\/api\/boards\/[^/]+\/tasks$/;
// A person's words typed in a task's conversation (`from: "thread"`). A client steers on the same
// route through `act`, so it is the server's to use but not refused to the relay.
const BOARD_THREAD_STEER = /^\/api\/tasks\/[\w-]+\/steer$/;
const BOARD_THREAD_POST = new RegExp(
  `${BOARD_THREAD_CLAIM.source}|${BOARD_THREAD_CONVERSATION.source}|${BOARD_SEAT_POST.source}|${BOARD_TASK_POST.source}`,
);
const BOARD_THREAD_WRITE = new RegExp(`${BOARD_THREAD_LINK.source}|${BOARD_THREAD_POST.source}`);

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

type LinkedOperation = keyof typeof LinkedDeliveryResults;
type LinkedData<K extends LinkedOperation> = (typeof LinkedDeliveryResults)[K]["Type"];

const linkedRefusal = (status: 403 | 404) =>
  new DeliveryError({
    reason: "refused",
    status,
    detail: "The delivery operation is unavailable.",
  });

const validPeerId = Schema.is(LinkedHandoffPeerId);
const OwnerThreadIndex = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      environmentId: Schema.String.check(Schema.isPattern(/^[^\s\p{C}/]{1,256}$/u)),
      threadId: Schema.String.check(Schema.isPattern(/^[^\s\p{C}]{1,1024}$/u)),
      linked: Schema.Boolean,
    }),
  ),
});

const encodeBundleJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const decodeLinkedJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const decodeEngine = <A>(schema: Schema.Decoder<A>, options?: SchemaAST.ParseOptions) =>
  Effect.fn("DeliveryService.decodeEngine")(function* (body: unknown) {
    return yield* Schema.decodeUnknownEffect(
      schema,
      options,
    )(body).pipe(
      Effect.mapError(
        () =>
          new DeliveryError({
            reason: "invalid",
            detail: "The linked delivery response is incompatible.",
          }),
      ),
    );
  });

const queryPath = (path: string, query: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.size === 0 ? path : `${path}?${params}`;
};

export type OwnerThreadIndexSnapshot = {
  readonly ties: ReadonlyMap<ThreadId, boolean>;
  readonly uncertainAfter?: number;
};

export class DeliveryService extends Context.Service<
  DeliveryService,
  {
    readonly readLinked: <K extends LinkedDeliveryRead["operation"]>(
      input: Extract<LinkedDeliveryRead, { operation: K }>,
    ) => Effect.Effect<LinkedData<K>, DeliveryError>;
    /** Null when the engine applied the action but answered in a shape this version cannot read. */
    readonly actLinked: <K extends LinkedDeliveryAction["operation"]>(
      input: Extract<LinkedDeliveryAction, { operation: K }>,
    ) => Effect.Effect<LinkedData<K> | null, DeliveryError>;
    readonly peerHandoff: (
      input: LinkedHandoffPeerRequest,
      verifiedReturnPeer?: string,
    ) => Effect.Effect<
      (typeof LinkedHandoffPeerResponses)[LinkedHandoffPeerRequest["operation"]]["Type"],
      DeliveryError
    >;
    readonly ownerHandoffRequest: (
      method: "GET" | "POST",
      path: string,
      body?: unknown,
    ) => Effect.Effect<unknown, DeliveryError>;
    readonly ownerTiedThreads: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<OwnerThreadIndexSnapshot, DeliveryError>;
    readonly setBoardLinkedVisibility: (
      input: typeof DeliverySetBoardLinkedVisibility.Type,
    ) => Effect.Effect<typeof DeliveryBoardLinkedVisibility.Type, DeliveryError>;
    readonly setTaskLinkedHidden: (
      input: typeof DeliverySetTaskLinkedHidden.Type,
    ) => Effect.Effect<typeof DeliveryTaskLinkedHidden.Type, DeliveryError>;
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
    readonly boardThreadConfiguration: Effect.Effect<string, DeliveryError>;
    /**
     * The engine's approval key for keyed board writes, read on each use so a key saved in
     * Settings applies at once. Undefined when neither the variable nor Settings has one.
     */
    readonly boardApprovalKey: Effect.Effect<string | undefined>;
    readonly boardApprovalKeyStatus: Effect.Effect<DeliveryBoardApprovalKeyStatus, DeliveryError>;
    /** Saves the key in the server's secret store, or clears it with `null`. */
    readonly setBoardApprovalKey: (
      key: string | null,
    ) => Effect.Effect<DeliveryBoardApprovalKeyStatus, DeliveryError>;
    /**
     * Server-owned board writes. The generic `act` relay refuses them.
     */
    readonly boardThreadAct: (input: {
      readonly method: "PUT" | "DELETE" | "POST";
      readonly configuration?: string;
      readonly path: string;
      readonly body: unknown;
    }) => Effect.Effect<DeliveryResponse, DeliveryError>;
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
    /**
     * What a conversation is bound to and who joins it. `boardOwned` is the caller's word, from the
     * thread's own board marker, that it is a board task's, before the board has given it a lineup.
     */
    readonly threadState: (
      threadId: ThreadId,
      options?: { readonly boardOwned?: boolean },
    ) => Effect.Effect<DeliveryThreadState, DeliveryError>;
    readonly threadHasDeliveryBinding: (
      threadId: ThreadId,
    ) => Effect.Effect<boolean, DeliveryError>;
    /** Gives up a team choice whose setup never completed. A bound thread cannot be released. */
    readonly releaseThread: (
      threadId: ThreadId,
    ) => Effect.Effect<DeliveryThreadState, DeliveryError>;
    /**
     * Replaces who joins a conversation from its next message on; null makes it an ordinary one.
     * A board task's thread is refused: its team is the board's.
     */
    readonly setThreadLineup: (
      input: DeliverySetThreadLineupInput,
    ) => Effect.Effect<DeliveryThreadState, DeliveryError>;
    /**
     * The team a board task's thread shows, as the board picks it; null is none. The only lineup
     * such a thread has: what a person set on it is ignored. Never fails, as the board gives it
     * again on the next pass.
     */
    readonly setBoardLineup: (
      threadId: ThreadId,
      lineup: DeliveryThreadLineup | null,
    ) => Effect.Effect<void>;
    /** Makes a thread with a board task's marker the board's, keeping any lineup it gave it. */
    readonly ownBoardThread: (threadId: ThreadId) => Effect.Effect<void>;
    /** The team the board gave a thread: undefined for one the board never gave one, even none. */
    readonly boardLineupOf: (
      threadId: ThreadId,
    ) => Effect.Effect<DeliveryThreadLineup | null | undefined>;
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
    readonly terminalEntryScript: Effect.Effect<string | null, DeliveryError>;
  }
>()("t3/delivery/DeliveryService") {}

const disabled = () =>
  Effect.fail(new DeliveryError({ reason: "disabled", detail: "Delivery is turned off." }));

type TestThreadIndex = Pick<
  DeliveryService["Service"],
  "ownerTiedThreads" | "threadHasDeliveryBinding"
>;

export const layerTestWithThreadIndex = (overrides: Partial<TestThreadIndex>) =>
  Layer.succeed(
    DeliveryService,
    DeliveryService.of({
      read: disabled,
      readLinked: disabled,
      actLinked: disabled,
      peerHandoff: disabled,
      ownerHandoffRequest: disabled,
      ownerTiedThreads: overrides.ownerTiedThreads ?? (() => Effect.succeed({ ties: new Map() })),
      setBoardLinkedVisibility: disabled,
      setTaskLinkedHidden: disabled,
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
      boardThreadConfiguration: Effect.succeed("test"),
      boardApprovalKey: Effect.undefined,
      boardApprovalKeyStatus: Effect.succeed({ source: "none", stored: false }),
      setBoardApprovalKey: disabled,
      boardThreadAct: disabled,
      bindThread: disabled,
      refreshThread: disabled,
      threadState: Effect.fn("DeliveryService.threadState")(() =>
        Effect.succeed({ binding: null, pending: null }),
      ),
      threadHasDeliveryBinding: overrides.threadHasDeliveryBinding ?? (() => Effect.succeed(false)),
      releaseThread: Effect.fn("DeliveryService.releaseThread")(() =>
        Effect.succeed({ binding: null, pending: null }),
      ),
      setThreadLineup: disabled,
      setBoardLineup: Effect.fn("DeliveryService.setBoardLineup")(() => Effect.void),
      ownBoardThread: Effect.fn("DeliveryService.ownBoardThread")(() => Effect.void),
      boardLineupOf: Effect.fn("DeliveryService.boardLineupOf")(() => Effect.undefined),
      prepareThread: Effect.fn("DeliveryService.prepareThread")(() => Effect.succeed(false)),
      terminalEntryScript: Effect.succeed(null),
    }),
  );

/** Inert service with Delivery disabled. */
export const layerTest = layerTestWithThreadIndex({});

const make = Effect.fn("DeliveryService.make")(function* (
  deriveConfigMap: typeof deriveProviderInstanceConfigMap,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const processEnvironment = yield* HostProcess.Environment;

  // Only this service writes the saved key, so it is read from the store once.
  let savedKey: Option.Option<string> | undefined;
  const keyStorageError = (detail: string) => () =>
    new DeliveryError({ reason: "storage", detail });
  const readSavedKey = Effect.suspend(() =>
    savedKey !== undefined
      ? Effect.succeed(savedKey)
      : secretStore.get(BOARD_APPROVAL_KEY_SECRET).pipe(
          Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
          Effect.tap((read) => Effect.sync(() => (savedKey = read))),
          Effect.mapError(keyStorageError("The saved board approval key could not be read.")),
        ),
  );
  const readBoardApprovalKey = readSavedKey.pipe(
    Effect.map((saved) =>
      resolveBoardApprovalKey(processEnvironment, Option.getOrUndefined(saved)),
    ),
  );
  const boardKeyWrites = yield* Semaphore.make(1);

  const bindingsPath = path.join(config.stateDir, "delivery-threads.json");
  const bindings = new Map<string, DeliveryThreadBinding>();
  const pending = new Map<string, DeliveryThreadPending>();
  const lineups = new Map<string, DeliveryOrchestrationConfig | null>();
  const rememberedLineups = new Map<string, DeliveryRememberedLineup>();
  const boardLineupsPath = path.join(config.stateDir, "delivery-board-lineups.json");
  const boardLineups = new Map<string, DeliveryThreadLineup | null>();
  const writeLock = yield* Semaphore.make(1);
  const boardLineupWrites = yield* Semaphore.make(1);
  let boardLineupsUnsaved = false;
  const boardSeatWrites = yield* Semaphore.make(1);
  const boardLinkWrites = yield* Semaphore.make(1);

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
  // A board lineup file that is not there or not understood is an empty one.
  const loadedBoardLineups = yield* fileSystem
    .readFileString(boardLineupsPath)
    .pipe(Effect.flatMap(decodeBoardLineups), Effect.result);
  if (loadedBoardLineups._tag === "Success") {
    for (const [threadId, lineup] of Object.entries(loadedBoardLineups.success))
      boardLineups.set(threadId, lineup);
  }
  /** A board task's thread: one the board gave a lineup, or one with a board task's own id. */
  const boardOwned = (threadId: string) =>
    boardLineups.has(threadId) || boardTaskOfMarker(threadId) !== null;
  /**
   * The team a conversation's own sessions start with. A board task's thread has none: a binding
   * a person saved on it is left in the store, for a build that predates board lineups, and is
   * neither shown nor enforced.
   */
  const teamBindingOf = (threadId: string) =>
    boardOwned(threadId) ? undefined : bindings.get(threadId);

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
  const threadIndexLock = yield* Semaphore.make(1);
  const ownerWritesIdle = yield* Latch.make(true);
  let ownerWrites = 0;
  const ownerThreadCache = new Map<
    EnvironmentId,
    {
      until: number;
      value: Exit.Exit<OwnerThreadIndexSnapshot, DeliveryError>;
    }
  >();
  const lastGoodOwnerThreadIndex = new Map<
    EnvironmentId,
    {
      readonly ties: ReadonlyMap<ThreadId, boolean>;
      readonly requestedAt: number;
    }
  >();
  let ownerIndexConfiguration:
    | { readonly revision: number; readonly enabled: boolean; readonly engineUrl: string }
    | undefined;
  let ownerIndexGeneration = 0;
  let discoveryGeneration = 0;
  let discoveryConfiguration = "";
  const invalidateDiscovery = (includeOwnerIndex = true) => {
    discoveryGeneration++;
    discoveryCache.clear();
    if (includeOwnerIndex) {
      ownerIndexGeneration++;
      ownerThreadCache.clear();
    }
  };

  const readOwnerIndexConfiguration = Effect.fn("DeliveryService.readOwnerIndexConfiguration")(
    function* () {
      const { revision, enabled, engineUrl } = yield* settingsService
        .withSettingsSnapshot((settings) =>
          settingsService.deliveryConfigurationRevision.pipe(
            Effect.map((revision) => ({ revision, ...settings.delivery })),
          ),
        )
        .pipe(
          Effect.mapError(
            () =>
              new DeliveryError({
                reason: "unreachable",
                detail: "Delivery settings could not be read.",
              }),
          ),
        );
      if (
        ownerIndexConfiguration?.revision !== revision ||
        ownerIndexConfiguration.enabled !== enabled ||
        ownerIndexConfiguration.engineUrl !== engineUrl
      ) {
        ownerIndexConfiguration = { revision, enabled, engineUrl };
        ownerThreadCache.clear();
        lastGoodOwnerThreadIndex.clear();
      }
      return ownerIndexConfiguration;
    },
  );

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

  const readConfiguration = Effect.fn("DeliveryService.readConfiguration")(function* () {
    const settings = yield* delivery;
    const environment = yield* HostProcess.Environment;
    return configurationKey(settings.enabled, settings.engineUrl, environment);
  });
  const assertConfiguration = Effect.fn("DeliveryService.assertConfiguration")(function* (
    expected: string,
  ) {
    if ((yield* readConfiguration()) !== expected)
      return yield* new DeliveryError({
        reason: "invalid",
        status: 409,
        detail: "Delivery launch blocked: configuration-changed. No work was submitted.",
      });
  });
  const isPeerInvocation = Effect.serviceOption(McpInvocationContext.McpInvocationContext).pipe(
    Effect.map((scope) =>
      McpInvocationContext.isLinkedDeliveryCaller(Option.getOrUndefined(scope)),
    ),
  );
  const requireOwner = isPeerInvocation.pipe(
    Effect.flatMap((isPeer) => (isPeer ? Effect.fail(linkedRefusal(403)) : Effect.void)),
  );
  const request = Effect.fn("DeliveryService.request")(
    function* (
      method: "GET" | "POST" | "PUT" | "DELETE",
      enginePath: string,
      requestBody?: unknown,
      bounded = false,
      observedHealth?: { engineUrl: string; response: DeliveryResponse },
      expectedConfiguration?: string,
      dispatchDeadline?: number,
      format?: "json" | "binary" | "linked-handoff" | "owner-handoff" | "owner-thread-index",
    ) {
      const ownerThreadIndex = format === "owner-thread-index";
      const linked = format === "json" || format === "binary" || format === "linked-handoff";
      const handoff = format === "linked-handoff" || format === "owner-handoff";
      const preparesBundle =
        method === "POST" &&
        (enginePath === "/api/handoffs/prepare" ||
          /^\/api\/linked\/tasks\/[\w-]+\/handoff$/.test(enginePath));
      const limit =
        handoff && preparesBundle
          ? LINKED_HANDOFF_BUNDLE_MAX_BYTES + 1_048_576
          : ownerThreadIndex
            ? 3 * 1_048_576
            : 1_048_576;
      if (linked) {
        const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
        if (Option.getOrUndefined(scope)?.client?.linked !== true) return yield* linkedRefusal(403);
      } else if (!ownerThreadIndex && (yield* isPeerInvocation)) {
        return yield* linkedRefusal(403);
      }
      if (expectedConfiguration !== undefined) yield* assertConfiguration(expectedConfiguration);
      const settings = yield* delivery;
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
          if (linked && !/^\/api\/linked(?:\/[A-Za-z0-9_-]+)+(?:\?.*)?$/.test(enginePath)) {
            throw new Error("invalid linked route");
          }
          const target = new URL(enginePath, base);
          const isLinkedRoute = /^\/api\/linked(?:\/|$)/.test(target.pathname);
          if (target.origin !== base.origin || isLinkedRoute !== linked) {
            throw new Error("invalid engine route");
          }
          return target.toString();
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
            : yield* readHealth(settings.engineUrl, bounded || expectedConfiguration !== undefined);
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
      const base =
        method === "GET"
          ? HttpClientRequest.get(url)
          : method === "PUT"
            ? HttpClientRequest.put(url)
            : method === "DELETE"
              ? HttpClientRequest.delete(url)
              : HttpClientRequest.post(url);
      const prepared =
        method === "GET" ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(requestBody ?? {}));
      if (expectedConfiguration !== undefined) yield* assertConfiguration(expectedConfiguration);
      if (dispatchDeadline !== undefined && (yield* Clock.currentTimeMillis) >= dispatchDeadline) {
        return yield* new DeliveryError({
          reason: "unreachable",
          detail: "Delivery preflight timed out. No work was submitted.",
        });
      }
      if (method !== "GET") {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            ownerWrites++;
            ownerWritesIdle.closeUnsafe();
            invalidateDiscovery();
          }),
          () =>
            Effect.sync(() => {
              invalidateDiscovery();
              lastGoodOwnerThreadIndex.clear();
              if (--ownerWrites === 0) ownerWritesIdle.openUnsafe();
            }),
        );
      }
      const response = yield* httpClient.execute(prepared).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
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
      if (bounded && Number(response.headers["content-length"]) > limit) {
        return yield* new DeliveryError({
          reason: "invalid",
          status: 413,
          detail: !linked
            ? "Discovery response exceeds its size limit."
            : "Linked delivery response exceeds its size limit.",
        });
      }
      if (linked && !handoff && (response.status < 200 || response.status >= 300)) {
        const message =
          method === "POST" && response.status >= 400 && response.status < 500
            ? yield* readBoundedBody(response, limit).pipe(
                Effect.flatMap((bytes) => decodeLinkedJson(bytes.toString("utf8"))),
                Effect.timeout("4 seconds"),
                Effect.option,
                Effect.map((body) => Option.flatMap(body, decodeRefusal)),
                Effect.map((refusal) =>
                  Option.getOrUndefined(
                    Option.map(refusal, ({ error }) => error.trim().slice(0, 500)),
                  ),
                ),
              )
            : undefined;
        return yield* new DeliveryError({
          reason: "refused",
          status: response.status,
          detail: message || "The linked delivery operation was refused.",
          ...(message ? { linkedRefusalMessage: message } : {}),
        });
      }
      if (format !== undefined) {
        const bytes = yield* readBoundedBody(response, format === "binary" ? 524_288 : limit).pipe(
          Effect.timeout("4 seconds"),
          Effect.mapError(
            (error) =>
              new DeliveryError({
                reason: error._tag === "TimeoutError" ? "unreachable" : "invalid",
                ...(error._tag === "BodyTooLarge" ? { status: 413 } : {}),
                detail: handoff
                  ? "The hand-off response could not be read."
                  : "The linked delivery response could not be read.",
              }),
          ),
        );
        const bodyKey =
          typeof requestBody === "object" && requestBody !== null && "key" in requestBody
            ? requestBody.key
            : undefined;
        const body: unknown =
          format === "binary"
            ? {
                mediaType: response.headers["content-type"] ?? "application/octet-stream",
                data: bytes.toString("base64"),
              }
            : yield* decodeLinkedJson(bytes.toString("utf8")).pipe(
                Effect.mapError(
                  () =>
                    new DeliveryError({
                      reason: "invalid",
                      detail: "The linked delivery response is incompatible.",
                    }),
                ),
              );
        if (
          ownerThreadIndex
            ? response.status !== 200
            : response.status < 200 || response.status >= 300
        ) {
          const refusal = decodeRefusal(body);
          const key = typeof bodyKey === "string" ? bodyKey : undefined;
          const message = refusal._tag === "Some" ? refusal.value.error : `HTTP ${response.status}`;
          return yield* new DeliveryError({
            reason: response.status >= 500 || response.status === 408 ? "unreachable" : "refused",
            detail: (key ? message.replaceAll(key, "[redacted]") : message).slice(0, 500),
            status: response.status,
          });
        }
        return { readAt: DateTime.formatIso(yield* DateTime.now), body } satisfies DeliveryResponse;
      }
      // The engine answers a clear with 204 and no body.
      if (response.status === 204) {
        return {
          readAt: DateTime.formatIso(yield* DateTime.now),
          body: null,
        } satisfies DeliveryResponse;
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
    // The write stays in flight through response decoding.
    Effect.scoped,
  );

  const linkedRequest = Effect.fn("DeliveryService.linkedRequest")(function* (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    format: "json" | "binary" | "linked-handoff" = "json",
  ) {
    return (yield* request(
      method,
      `/api/linked/${path}`,
      body,
      true,
      undefined,
      undefined,
      undefined,
      format,
    )).body;
  });

  const readLinked = Effect.fn("DeliveryService.readLinked")(function* (raw: LinkedDeliveryRead) {
    const input = yield* decodeEngine(LinkedDeliveryRead)(raw);
    const taskPath = "taskId" in input ? `tasks/${encodeURIComponent(input.taskId)}` : "";
    switch (input.operation) {
      case "boards":
        return yield* linkedRequest("GET", "boards").pipe(
          Effect.flatMap(decodeEngine(LinkedDeliveryResults.boards)),
        );
      case "board":
        return yield* linkedRequest("GET", `boards/${encodeURIComponent(input.boardId)}`).pipe(
          Effect.flatMap(decodeEngine(LinkedDeliveryResults.board)),
        );
      case "search":
        return yield* linkedRequest(
          "GET",
          queryPath("tasks", { q: input.q, board: input.boardId, limit: input.limit }),
        ).pipe(Effect.flatMap(decodeEngine(LinkedDeliveryResults.search)));
      case "task": {
        const task = yield* linkedRequest("GET", taskPath).pipe(
          Effect.flatMap(decodeEngine(LinkedDeliveryResults.comment)),
        );
        const [messages, timeline] = yield* Effect.all(
          [
            linkedRequest("GET", `${taskPath}/messages`).pipe(
              Effect.flatMap(decodeEngine(LinkedDeliveryResults.messages)),
            ),
            linkedRequest("GET", `${taskPath}/timeline`).pipe(
              Effect.flatMap(decodeEngine(LinkedDeliveryResults.timeline)),
            ),
          ],
          { concurrency: "unbounded" },
        );
        return yield* decodeEngine(LinkedDeliveryResults.task)({
          ...task,
          ...messages,
          ...timeline,
        });
      }
      case "messages":
        return yield* linkedRequest("GET", `${taskPath}/messages`).pipe(
          Effect.flatMap(decodeEngine(LinkedDeliveryResults.messages)),
        );
      case "timeline":
        return yield* linkedRequest("GET", `${taskPath}/timeline`).pipe(
          Effect.flatMap(decodeEngine(LinkedDeliveryResults.timeline)),
        );
      case "events":
        return yield* linkedRequest(
          "GET",
          queryPath(`${taskPath}/events`, { after: input.after }),
        ).pipe(Effect.flatMap(decodeEngine(LinkedDeliveryResults.events)));
      case "file":
        return yield* linkedRequest(
          "GET",
          queryPath(`${taskPath}/files/${encodeURIComponent(input.fileId)}`, {
            from: input.from,
            length: input.length,
          }),
        ).pipe(Effect.flatMap(decodeEngine(LinkedDeliveryResults.file)));
      case "attached":
        return yield* linkedRequest(
          "GET",
          `${taskPath}/runs/${encodeURIComponent(input.runId)}/attached`,
        ).pipe(Effect.flatMap(decodeEngine(LinkedDeliveryResults.attached)));
      case "attachedFile":
        return yield* linkedRequest(
          "GET",
          queryPath(`${taskPath}/runs/${encodeURIComponent(input.runId)}/attached/file`, {
            seat: input.seat,
            name: input.name,
          }),
          undefined,
          "binary",
        ).pipe(Effect.flatMap(decodeEngine(LinkedDeliveryResults.attachedFile)));
    }
  });

  const actLinked = Effect.fn("DeliveryService.actLinked")(function* (raw: LinkedDeliveryAction) {
    const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
    const client = Option.getOrUndefined(scope)?.client;
    if (client?.linked !== true || client.access === "read-only") return yield* linkedRefusal(403);
    const { operation, taskId, ...fields } = yield* decodeEngine(LinkedDeliveryAction)(raw);
    const endpoint = {
      comment: "messages",
      answer: "answer",
      control: "control",
      steer: "steer",
      take: "take",
      renew: "take/renew",
      release: "take/release",
    }[operation];
    const body = "answer" in fields ? { replyTo: fields.replyTo, ...fields.answer } : fields;
    const response = yield* linkedRequest(
      "POST",
      `tasks/${encodeURIComponent(taskId)}/${endpoint}`,
      { ...body, access: "act", by: client.label },
    );
    // The engine applied it, so an answer this version cannot read is still a success: calling it
    // unsupported would invite a retry that does it twice.
    return yield* decodeEngine(LinkedDeliveryResults[operation])(response).pipe(
      Effect.orElseSucceed(() => null),
    );
  });

  const peerHandoff = Effect.fn("DeliveryService.peerHandoff")(function* (
    raw: LinkedHandoffPeerRequest,
    verifiedReturnPeer?: string,
  ) {
    const scope = Option.getOrUndefined(
      yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext),
    );
    const client = scope?.client;
    if (client?.linked !== true || !scope?.capabilities.has("orchestration"))
      return yield* linkedRefusal(403);
    const input = yield* decodeEngine(LinkedHandoffPeerRequest)(raw);
    const { operation } = input;
    const returnPeer =
      operation === "import"
        ? linkedReturnPeer(input.bundle.handoff)
        : operation === "settle"
          ? linkedReturnPeer(input.handoff)
          : null;
    // A return to a moved marker uses the original push's destination identity.
    if (returnPeer !== null && returnPeer !== verifiedReturnPeer)
      return yield* new DeliveryError({
        reason: "unreachable",
        detail: "The reciprocal link for this return could not be verified.",
      });
    const peer = returnPeer ?? client.sessionId;
    if (!validPeerId(peer)) return yield* linkedRefusal(403);
    const read = operation === "list" || operation === "get";
    if (!read && client.access === "read-only") return yield* linkedRefusal(403);
    const acting = { access: "act", peer };
    const perform = (method: "GET" | "POST", path: string, body?: unknown) =>
      linkedRequest(method, path, body, "linked-handoff").pipe(
        Effect.flatMap(
          decodeEngine(
            LinkedHandoffPeerResponses[operation] as Schema.Decoder<
              (typeof LinkedHandoffPeerResponses)[typeof operation]["Type"]
            >,
          ),
        ),
      );
    switch (operation) {
      case "prepare":
        return yield* perform("POST", `tasks/${input.taskId}/handoff`, {
          ...acting,
          by: client.label,
          board: input.boardId,
          handoff: input.handoff,
          maxBytes: LINKED_HANDOFF_BUNDLE_MAX_BYTES,
        });
      case "import": {
        const encoded = yield* encodeBundleJson(input.bundle).pipe(
          Effect.mapError(
            () =>
              new DeliveryError({ reason: "invalid", detail: "The hand-off bundle is invalid." }),
          ),
        );
        if (Buffer.byteLength(encoded) > LINKED_HANDOFF_BUNDLE_MAX_BYTES)
          return yield* new DeliveryError({
            reason: "refused",
            status: 413,
            detail: "The bundle exceeds the linked hand-off size limit.",
          });
        return yield* perform("POST", "imports", {
          ...acting,
          by: client.label,
          board: input.boardId,
          bundle: input.bundle,
        });
      }
      case "settle": {
        const { handoff, root, tasks, digest } = input;
        return yield* perform("POST", `transfers/${handoff}/settle`, {
          ...acting,
          root,
          tasks,
          digest,
        });
      }
      case "commit":
        return yield* perform("POST", `handoffs/${input.handoff}/commit`, {
          ...acting,
          receipt: input.receipt,
        });
      case "cancel":
        return yield* perform("POST", `handoffs/${input.handoff}/cancel`, {
          ...acting,
          answer: input.answer,
        });
      case "list":
        return yield* perform("GET", queryPath("handoffs", { peer }));
      case "get":
        return yield* perform("GET", queryPath(`handoffs/${input.handoff}`, { peer }));
    }
  });

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

  const stateOf = (threadId: ThreadId, boardHint = false): DeliveryThreadState => {
    if (boardHint || boardOwned(threadId)) {
      // The board's team only: a person's binding, lineup or held team choice saved here is not
      // the board's, and stays on disk for a build that predates board lineups.
      const lineup = boardLineups.get(threadId);
      return {
        binding: null,
        pending: null,
        ...(lineup ? { boardLineup: lineup } : {}),
        ...(lineup && lineup.participants.length >= 2 ? { lineup } : {}),
      };
    }
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

  const refuseBoardOwned = (threadId: ThreadId) =>
    boardOwned(threadId)
      ? Effect.fail(
          new DeliveryError({
            reason: "refused",
            detail: "The board picks this task's team and models. Change them on the board.",
          }),
        )
      : Effect.void;

  const setThreadLineup = Effect.fn("DeliveryService.setThreadLineup")(function* (
    input: DeliverySetThreadLineupInput,
  ) {
    yield* requireOwner;
    yield* storeReadable;
    yield* refuseBoardOwned(input.threadId);
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

  const setBoardLineup = Effect.fn("DeliveryService.setBoardLineup")(function* (
    threadId: ThreadId,
    lineup: DeliveryThreadLineup | null,
  ) {
    const current = boardLineups.get(threadId);
    // What is shown changes at once; a save that failed is tried again on the next call.
    if (current !== undefined && sameBoardLineup(current, lineup) && !boardLineupsUnsaved) return;
    boardLineups.set(threadId, lineup);
    yield* boardLineupWrites.withPermits(1)(
      Effect.suspend(() => encodeBoardLineups(Object.fromEntries(boardLineups))).pipe(
        Effect.flatMap((contents) =>
          writeFileStringAtomically({ filePath: boardLineupsPath, contents }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        ),
        Effect.matchCauseEffect({
          onSuccess: () => Effect.sync(() => (boardLineupsUnsaved = false)),
          onFailure: (cause) => {
            const first = !boardLineupsUnsaved;
            boardLineupsUnsaved = true;
            return first
              ? Effect.logWarning("Board lineups were not saved; the next change tries again.", {
                  cause,
                })
              : Effect.void;
          },
        }),
      ),
    );
  });

  const ownBoardThread = Effect.fn("DeliveryService.ownBoardThread")(function* (
    threadId: ThreadId,
  ) {
    yield* setBoardLineup(threadId, boardLineups.get(threadId) ?? null);
  });

  const bindThread = Effect.fn("DeliveryService.bindThread")(function* (
    input: DeliveryBindThreadInput,
    configuration?: string,
  ) {
    yield* requireOwner;
    yield* storeReadable;
    yield* refuseBoardOwned(input.threadId);
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
    yield* requireOwner;
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
    yield* requireOwner;
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

  const checkRepository = Effect.fn("DeliveryService.checkRepository")(
    function* (
      registration: (typeof Discovery.DiscoveryRegistrations.Type)[number],
      observedHealth?: { engineUrl: string; response: DeliveryResponse },
      expectedConfiguration?: string,
    ) {
      const response = yield* request(
        "GET",
        `/api/repositories/${encodeURIComponent(registration.id)}/discovery-check`,
        undefined,
        true,
        observedHealth,
        expectedConfiguration,
      ).pipe(
        Effect.mapError((error) =>
          error.reason === "refused" && error.status === 504
            ? new DeliveryError({
                reason: "unreachable",
                status: error.status,
                detail: "The engine timed out checking the repository.",
              })
            : error,
        ),
      );
      const checked = yield* decodeRepositoryCheck(response.body).pipe(
        Effect.mapError(
          () =>
            new DeliveryError({
              reason: "invalid",
              detail: "The repository check response is incompatible.",
            }),
        ),
      );
      return (
        checked.ok &&
        checked.kind === "own" &&
        registration.kind === "own" &&
        checked.id === registration.id &&
        sameFolder(checked.path, registration.path, hostPlatform)
      );
    },
    (effect) =>
      effect.pipe(
        Effect.timeout("4 seconds"),
        Effect.catchTags({
          TimeoutError: () =>
            Effect.fail(
              new DeliveryError({
                reason: "unreachable",
                detail: "The repository check did not answer.",
              }),
            ),
        }),
      ),
  );

  const discoveryRead = Effect.fn("DeliveryService.discoveryRead")(function* (
    configuration: string,
    enginePath: string,
    observedHealth?: { engineUrl: string; response: DeliveryResponse },
  ) {
    const key = `owner:${configuration}:${enginePath}`;
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
                Effect.timeout("4 seconds"),
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
    if (yield* isPeerInvocation) {
      return {
        ...Discovery.emptyDiscovery(
          input,
          { environmentId: suppliedCaller.environmentId },
          "unavailable",
          DateTime.formatIso(yield* DateTime.now),
          null,
        ),
        diagnostics: ["unauthorized"],
      };
    }
    const driver = suppliedCaller.driver ?? providerDriver;
    const caller = { ...suppliedCaller, ...(driver === undefined ? {} : { driver }) };
    const settings = yield* delivery;
    const environment = yield* HostProcess.Environment;
    const key = configurationKey(settings.enabled, settings.engineUrl, environment);
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
    if (valid._tag === "Failure" || Discovery.invalidDiscoveryCards(input))
      return { ...snapshot, diagnostics: ["invalid-request"] };
    if (!settings.enabled) return { ...snapshot, diagnostics: ["disabled"] };
    if (input.fresh || input.preflight) discoveryCache.clear();
    const readTimes: string[] = [];
    const endpointFailure = (path: string) => (error: DeliveryError) => ({
      _tag: "DiscoveryEndpointError" as const,
      path,
      error,
    });
    let observedHealth: { engineUrl: string; response: DeliveryResponse } | undefined;
    const read = Effect.fn("DeliveryService.discoveryEndpoint")(function* <A>(
      enginePath: string,
      schema: Schema.Decoder<A>,
    ) {
      const operation =
        input.preflight && enginePath === "/api/repositories?discovery=1"
          ? request("GET", enginePath, undefined, true, observedHealth)
          : discoveryRead(configuration, enginePath, observedHealth);
      const response = yield* operation.pipe(Effect.mapError(endpointFailure(enginePath)));
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
    const result = yield* Effect.gen(function* () {
      const health = yield* read("/api/health", Discovery.DiscoveryHealth);
      if (!health.ok) return { ...snapshot, diagnostics: ["unreachable" as const] };
      const [[repository, repositories, data], teams, lanes] = yield* Effect.all(
        [
          Effect.gen(function* () {
            const [repository, registrations, delivery] = yield* Effect.all(
              [
                read(
                  `/api/repository?folder=${encodeURIComponent(input.folder)}`,
                  Discovery.DiscoveryRepository,
                ),
                read("/api/repositories?discovery=1", Discovery.DiscoveryRegistrations),
                read(
                  input.task
                    ? `/api/delivery?task=${encodeURIComponent(input.task)}`
                    : "/api/delivery",
                  Discovery.DiscoveryDelivery,
                ),
              ],
              { concurrency: 3 },
            );
            const target = Discovery.discoveryTarget(
              registrations,
              delivery,
              repository.readable && repository.identityProblem === null
                ? (repository.canonicalPath ?? null)
                : null,
              input.board,
            );
            const registered = input.preflight ? target.repository : undefined;
            // Target validation and the scoped snapshot share the final observation round.
            const [checked, link] = yield* Effect.all(
              [
                registered === undefined
                  ? Effect.succeed(false)
                  : checkRepository(registered, observedHealth).pipe(
                      Effect.mapError(
                        endpointFailure(
                          `/api/repositories/${encodeURIComponent(registered.id)}/discovery-check`,
                        ),
                      ),
                    ),
                Effect.gen(function* () {
                  const selected = target.selected;
                  if (!selected) return { selected, data: delivery };
                  const query = new URLSearchParams({ board: selected.id });
                  if (input.route) query.set("route", input.route);
                  const taskRequests = delivery.tracking.filter(
                    (row) =>
                      input.task !== undefined &&
                      row.task !== null &&
                      row.request !== null &&
                      row.task.id === input.task &&
                      row.request?.task === input.task &&
                      row.task.repository === selected.repository &&
                      row.task.base === selected.base &&
                      delivery.routes.some(
                        (route) => route.id === row.request?.route && route.board === selected.id,
                      ),
                  );
                  const scopedTask = input.task !== undefined && taskRequests.length === 1;
                  if (scopedTask) query.set("task", input.task!);
                  const data = yield* read(`/api/delivery?${query}`, Discovery.DiscoveryDelivery);
                  return {
                    selected,
                    data:
                      scopedTask || !input.task
                        ? data
                        : {
                            ...data,
                            tracking: [
                              ...data.tracking.filter((row) => row.task?.id !== input.task),
                              ...delivery.tracking.filter((row) => row.task?.id === input.task),
                            ],
                          },
                  };
                }),
              ],
              { concurrency: 2 },
            );
            return [
              repository,
              input.preflight && registered !== undefined && !checked ? [] : registrations,
              link.data,
            ] as const;
          }),
          read("/api/teams", Discovery.DiscoveryTeams),
          input.cards && input.board !== undefined
            ? read(
                `/api/lanes?${new URLSearchParams({ set: input.board })}`,
                Discovery.DiscoveryLanes,
              )
            : Effect.undefined,
        ],
        { concurrency: 3 },
      );

      const current = yield* delivery;
      if (
        generation !== discoveryGeneration ||
        key !== configurationKey(current.enabled, current.engineUrl, environment)
      )
        return { ...snapshot, diagnostics: ["configuration-changed" as const] };
      if (lanes !== undefined && lanes.set !== input.board)
        return { ...snapshot, diagnostics: ["invalid-request" as const] };
      const readAt = readTimes.toSorted()[0]!;
      return Discovery.projectDiscovery(
        input,
        caller,
        {
          ...snapshot,
          diagnostics: [],
          profile:
            snapshot.profile ??
            (health.profile === null ? null : Discovery.observationText(health.profile)),
          readAt,
          expiresAt: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(readAt), { seconds: 10 })),
        },
        {
          root:
            repository.readable && repository.identityProblem === null
              ? (repository.canonicalPath ?? null)
              : null,
          repositories,
          teams,
          delivery: data,
          lanes,
        },
      );
    }).pipe(Effect.timeout("10 seconds"), Effect.result);
    if (result._tag === "Success") return result.success;
    // A read that fails because the settings changed under it is a discarded observation.
    const latest = yield* delivery;
    if (
      generation !== discoveryGeneration ||
      key !== configurationKey(latest.enabled, latest.engineUrl, environment)
    )
      return { ...snapshot, diagnostics: ["configuration-changed" as const] };
    const failure = result.failure;
    const error = failure._tag === "DiscoveryEndpointError" ? failure.error : failure;
    const failedEndpoint =
      failure._tag === "DiscoveryEndpointError"
        ? new URL(failure.path, "http://discovery.invalid")
        : undefined;
    const code = deliveryFailureDiagnostic(error, {
      endpoint: failedEndpoint,
      task: input.task,
    });
    return { ...snapshot, diagnostics: [code] };
  });

  const preflightDeliveryRequest = Effect.fn("DeliveryService.preflightDeliveryRequest")(
    function* (body: unknown) {
      const dispatchDeadline = (yield* Clock.currentTimeMillis) + 3000;
      const refuse = (code: DeliveryDiscoveryDiagnostic) =>
        new DeliveryError({
          reason: "invalid",
          status: 409,
          detail: `Delivery launch blocked: ${code}. No work was submitted.`,
        });
      const input = yield* decodeDeliveryRequest(body).pipe(
        Effect.mapError(() => refuse("invalid-request")),
      );
      const configuration = yield* readConfiguration();
      const settings = yield* delivery;
      let observedHealth: { engineUrl: string; response: DeliveryResponse } | undefined;
      const read = Effect.fn("DeliveryService.launchPreflightRead")(function* <A>(
        path: string,
        schema: Schema.Decoder<A>,
      ): Effect.fn.Return<A, DeliveryError> {
        const response = yield* request(
          "GET",
          path,
          undefined,
          true,
          observedHealth,
          configuration,
        );
        if (path === "/api/health") observedHealth = { engineUrl: settings.engineUrl, response };
        return yield* Schema.decodeEffect(schema)(response.body).pipe(
          Effect.mapError(() => refuse("unsupported-server")),
        );
      });
      const health = yield* read("/api/health", Discovery.DiscoveryHealth);
      if (!health.ok) return yield* refuse("unreachable");
      const [route, teams, task] = yield* Effect.all(
        [
          Effect.gen(function* () {
            const [data, registrations] = yield* Effect.all(
              [
                read(
                  `/api/delivery?route=${encodeURIComponent(input.route)}`,
                  Discovery.DiscoveryDelivery,
                ),
                read("/api/repositories?discovery=1", Discovery.DiscoveryRegistrations),
              ],
              { concurrency: 2 },
            );
            const routes = data.routes.filter((item) => item.id === input.route);
            const route = routes.length === 1 ? routes[0] : undefined;
            if (!route) return yield* refuse("missing-target");
            if (data.version !== 1 || !data.scope || !data.selection)
              return yield* refuse("unsupported-server");
            if (
              data.scope.route !== input.route ||
              data.scope.board !== route.board ||
              data.selection.state !== "selected" ||
              data.selection.problem !== null ||
              data.selection.routeId !== route.id ||
              data.selection.projectId !== route.project ||
              route.identityProblem !== null
            )
              return yield* refuse("missing-target");
            const boards = data.boards.filter((item) => item.id === route.board);
            const board = boards.length === 1 ? boards[0] : undefined;
            if (!board?.base || board.repository !== route.repository || board.base !== route.base)
              return yield* refuse("missing-target");
            const projects = data.projects.filter((item) => item.id === route.project);
            const project = projects.length === 1 ? projects[0] : undefined;
            const registered = Discovery.registeredRepository(registrations, route.repository);
            if (!registered) return yield* refuse("unregistered-repository");
            if (
              !project ||
              project.branch !== route.base ||
              !Discovery.verifiedProjectRepository(
                registrations,
                project,
                registered.canonicalPath!,
              )
            )
              return yield* refuse("missing-deployment");
            if (!(yield* checkRepository(registered, observedHealth, configuration)))
              return yield* refuse("unregistered-repository");
            return route;
          }),
          read("/api/teams", Discovery.DiscoveryTeams),
          input.task === undefined
            ? Effect.undefined
            : read(
                `/api/tasks/${input.task}`,
                Schema.Struct({
                  id: Schema.String,
                  team: Schema.NullOr(Schema.String),
                  repository: Schema.NullOr(Schema.String),
                  base: Schema.NullOr(Schema.String),
                }),
              ).pipe(
                Effect.mapError((error) =>
                  error.status === 404 ? refuse("task-not-found") : error,
                ),
              ),
        ],
        { concurrency: 4 },
      );
      if (
        task &&
        (task.id !== input.task || task.repository !== route.repository || task.base !== route.base)
      )
        return yield* refuse("missing-target");
      const team = teams.find((item) => item.team === (task?.team ?? input.team));
      if (!team?.available || !team.takesTasks) return yield* refuse("missing-team");
      if (!team.seats.some((seat) => seat.available && seat.tools.includes("delivery")))
        return yield* refuse("unsupported-provider-tools");
      const finalHealth = yield* request(
        "GET",
        "/api/health",
        undefined,
        true,
        undefined,
        configuration,
      );
      const identity = yield* decodeDiscoveryHealth(finalHealth.body).pipe(
        Effect.mapError(() => refuse("unsupported-server")),
      );
      if (!identity.ok) return yield* refuse("unreachable");
      yield* assertConfiguration(configuration);
      return {
        configuration,
        observedHealth: { engineUrl: settings.engineUrl, response: finalHealth },
        dispatchDeadline,
      };
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
    yield* requireOwner;
    DeliveryThreadSession.clearDeliveryThreadSession(threadId);
    const settings = yield* delivery;
    // With delivery off nothing was ever bound through this service, and a
    // thread starts as it always did.
    if (!settings.enabled && bindings.size === 0 && pending.size === 0 && !storeProblem) {
      return false;
    }
    yield* storeReadable;
    const intent = boardOwned(threadId) ? undefined : pending.get(threadId);
    if (intent && !bindings.has(threadId)) {
      return yield* new DeliveryError({
        reason: "pending",
        detail: `Team ${intent.team} was chosen for this thread and its setup did not complete${intent.why ? `: ${intent.why}` : "."} Send again to retry, or choose "No team" to start it as an ordinary thread.`,
      });
    }
    const binding = teamBindingOf(threadId);
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
    const binding = teamBindingOf(threadId);
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
        invalidateDiscovery(false);
        DeliveryThreadSession.setDeliveryTerminalEntryScript(entryScriptOf(settings.delivery));
      }),
    ),
    Effect.forkScoped,
  );

  DeliveryThreadSession.registerDeliveryPreparer(prepareThread);
  DeliveryThreadSession.registerDeliveryReporter(reportEffective);
  DeliveryThreadSession.registerDeliveryTeamLookup((threadId) => teamBindingOf(threadId)?.team);
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
    readLinked: readLinked as DeliveryService["Service"]["readLinked"],
    actLinked: actLinked as DeliveryService["Service"]["actLinked"],
    peerHandoff,
    ownerHandoffRequest: Effect.fn("DeliveryService.ownerHandoffRequest")(
      function* (method, path, body) {
        if (
          !/^\/api\/(?:tasks\/[A-Za-z0-9_-]+|handoffs(?:\?open=1|\/(?:prepare|import|[A-Za-z0-9_-]+\/(?:commit|resolve)))?|transfers\/[A-Za-z0-9_-]+\/settle)$/.test(
            path,
          )
        )
          return yield* new DeliveryError({ reason: "invalid", detail: "Invalid hand-off route." });
        return (yield* request(
          method,
          path,
          body,
          true,
          undefined,
          undefined,
          undefined,
          "owner-handoff",
        )).body;
      },
    ),
    ownerTiedThreads: Effect.fn("DeliveryService.ownerTiedThreads")(
      function* (environmentId) {
        const settings = yield* readOwnerIndexConfiguration();
        if (!settings.enabled || settings.engineUrl.trim() === "")
          return { ties: new Map<ThreadId, boolean>() };
        const now = yield* Clock.currentTimeMillis;
        const cached = ownerThreadCache.get(environmentId);
        if (cached !== undefined && now < cached.until) return yield* cached.value;
        const read = Effect.gen(function* () {
          const { body } = yield* request(
            "GET",
            "/api/task-threads",
            undefined,
            true,
            undefined,
            undefined,
            undefined,
            "owner-thread-index",
          );
          const { threads } = yield* decodeEngine(OwnerThreadIndex, {
            onExcessProperty: "error",
          })(body);
          const index = new Map<ThreadId, boolean>();
          for (const entry of threads) {
            if (entry.environmentId !== environmentId) continue;
            const id = ThreadId.make(entry.threadId);
            index.set(id, entry.linked && index.get(id) !== false);
          }
          return index;
        });
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt === 2) {
            const idle = yield* ownerWritesIdle.await.pipe(Effect.timeoutOption("30 seconds"));
            if (Option.isNone(idle)) return yield* linkedRefusal(404);
          }
          const generation = ownerIndexGeneration;
          const requestedAt = yield* Clock.currentTimeMillis;
          const answer = yield* Effect.exit(read);
          const receivedAt = yield* Clock.currentTimeMillis;
          if ((yield* readOwnerIndexConfiguration()) !== settings) return yield* linkedRefusal(404);
          if (ownerWrites !== 0 || generation !== ownerIndexGeneration) continue;
          const previous = lastGoodOwnerThreadIndex.get(environmentId);
          if (Exit.isSuccess(answer)) {
            lastGoodOwnerThreadIndex.set(environmentId, { ties: answer.value, requestedAt });
          }
          const value = Exit.isSuccess(answer)
            ? Exit.succeed({ ties: answer.value })
            : previous === undefined
              ? Exit.failCause(answer.cause)
              : Exit.succeed({
                  ties: new Map<ThreadId, boolean>(
                    Array.from(previous.ties.keys(), (id) => [id, false]),
                  ),
                  uncertainAfter: previous.requestedAt,
                });
          ownerThreadCache.set(environmentId, { until: receivedAt + 3_000, value });
          return yield* value;
        }
        return yield* linkedRefusal(404);
      },
      (effect) => threadIndexLock.withPermit(effect),
    ),
    setBoardLinkedVisibility: Effect.fn("DeliveryService.setBoardLinkedVisibility")(
      function* (raw) {
        const { boardId, ...body } = yield* decodeEngine(DeliverySetBoardLinkedVisibility)(raw);
        return yield* request(
          "POST",
          `/api/boards/${encodeURIComponent(boardId)}/linked-visibility`,
          body,
        ).pipe(
          Effect.flatMap((response) => decodeEngine(DeliveryBoardLinkedVisibility)(response.body)),
        );
      },
    ),
    setTaskLinkedHidden: Effect.fn("DeliveryService.setTaskLinkedHidden")(function* (raw) {
      const { taskId, ...body } = yield* decodeEngine(DeliverySetTaskLinkedHidden)(raw);
      return yield* request("POST", `/api/tasks/${taskId}/linked-hidden`, body).pipe(
        Effect.flatMap((response) => decodeEngine(DeliveryTaskLinkedHidden)(response.body)),
      );
    }),
    act: Effect.fn("DeliveryService.act")((input) =>
      requireOwner.pipe(
        Effect.flatMap(() =>
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
            : BOARD_THREAD_WRITE.test(new URL(input.path, "http://delivery.invalid").pathname) ||
                /\/(?:linked-visibility|linked-hidden)\/?$/.test(
                  new URL(input.path, "http://delivery.invalid").pathname,
                )
              ? Effect.fail(
                  new DeliveryError({
                    reason: "refused",
                    detail:
                      "Board filings, conversation and seat records can only be written by the server.",
                  }),
                )
              : new URL(input.path, "http://delivery.invalid").pathname === "/api/delivery/requests"
                ? preflightDeliveryRequest(input.body).pipe(
                    Effect.flatMap(({ configuration, observedHealth, dispatchDeadline }) =>
                      request(
                        "POST",
                        input.path,
                        input.body,
                        false,
                        observedHealth,
                        configuration,
                        dispatchDeadline,
                      ),
                    ),
                  )
                : request("POST", input.path, input.body),
        ),
      ),
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
    boardThreadConfiguration: requireOwner.pipe(Effect.andThen(readConfiguration())),
    boardApprovalKey: readBoardApprovalKey.pipe(
      Effect.map((resolved) => resolved.key),
      Effect.catch((error) =>
        // A variable still wins when the store cannot be read.
        Effect.logWarning("The saved board approval key could not be read.", {
          why: error.detail,
        }).pipe(Effect.as(processEnvironment[BOARD_THREAD_KEY_VARIABLE] || undefined)),
      ),
      Effect.withSpan("DeliveryService.boardApprovalKey"),
    ),
    boardApprovalKeyStatus: requireOwner.pipe(
      Effect.andThen(readBoardApprovalKey),
      Effect.map((resolved) => resolved.status),
      Effect.withSpan("DeliveryService.boardApprovalKeyStatus"),
    ),
    setBoardApprovalKey: Effect.fn("DeliveryService.setBoardApprovalKey")((key: string | null) =>
      requireOwner.pipe(
        Effect.andThen(
          boardKeyWrites.withPermit(
            (key === null
              ? secretStore.remove(BOARD_APPROVAL_KEY_SECRET)
              : secretStore.set(BOARD_APPROVAL_KEY_SECRET, new TextEncoder().encode(key))
            ).pipe(
              Effect.ensuring(Effect.sync(() => (savedKey = undefined))),
              Effect.mapError(keyStorageError("The board approval key could not be saved.")),
              Effect.andThen(readBoardApprovalKey),
              Effect.map((resolved) => resolved.status),
            ),
          ),
        ),
      ),
    ),
    boardThreadAct: Effect.fn("DeliveryService.boardThreadAct")(function* (input) {
      const allowed =
        input.method === "POST"
          ? BOARD_THREAD_POST.test(input.path) || BOARD_THREAD_STEER.test(input.path)
          : BOARD_THREAD_LINK.test(input.path);
      if (!allowed)
        return yield* new DeliveryError({
          reason: "invalid",
          detail: "Invalid board thread mutation path.",
        });
      const write = request(
        input.method,
        input.path,
        input.body,
        false,
        undefined,
        input.configuration,
      );
      if (input.method !== "POST") return yield* boardLinkWrites.withPermit(write);
      // Serialize keyed seat writes and filings so they share the engine’s approval throttle.
      return yield* BOARD_SEAT_POST.test(input.path) || BOARD_TASK_POST.test(input.path)
        ? boardSeatWrites.withPermit(write)
        : write;
    }),
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
    threadState: Effect.fn("DeliveryService.threadState")(
      (threadId: ThreadId, options?: { readonly boardOwned?: boolean }) =>
        requireOwner.pipe(
          Effect.andThen(storeReadable),
          Effect.as(stateOf(threadId, options?.boardOwned === true)),
        ),
    ),
    threadHasDeliveryBinding: Effect.fn("DeliveryService.threadHasDeliveryBinding")((threadId) =>
      storeReadable.pipe(Effect.map(() => bindings.has(threadId) || pending.has(threadId))),
    ),
    releaseThread,
    setThreadLineup,
    setBoardLineup,
    ownBoardThread,
    boardLineupOf: Effect.fn("DeliveryService.boardLineupOf")((threadId: ThreadId) =>
      Effect.sync(() => boardLineups.get(threadId)),
    ),
    prepareThread,
    terminalEntryScript: requireOwner.pipe(Effect.andThen(delivery), Effect.map(entryScriptOf)),
  });
});

export const layer = (deriveConfigMap: typeof deriveProviderInstanceConfigMap) =>
  Layer.effect(DeliveryService, make(deriveConfigMap));
