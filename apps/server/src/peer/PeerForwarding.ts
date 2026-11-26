import {
  type EnvironmentId,
  DeliveryDiscoveryInput,
  type DeliveryDiscoverySnapshot,
  type LinkedDeliveryDiagnostic,
  type LinkedDeliveryRead,
  type LinkedDeliveryAction,
  type LinkedDeliveryBoardsResult,
  LinkedDeliveryResults,
  linkedDeliveryResult,
  OrchestratorMcpFailure,
  type OrchestratorMcpEnvironmentLinksResult,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  type PeerLink,
  type PeerLinkError,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import type * as Tool from "effect/ai/Tool";

import { runtimeModeRank } from "../mcp/delegatedTaskModes.ts";
import { assertNotLinked, callerLinkOrigin } from "../mcp/linkOrigin.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { readCaller, unavailable } from "../mcp/threadAccess.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import * as DeliveryService from "../delivery/DeliveryService.ts";
import { emptyDiscovery, invalidDiscoveryCards } from "../delivery/deliveryDiscovery.ts";

// Match local waits: return before MCP client timeouts and T3 Connect's ~100 s idle drop.
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 45_000;

type Scope = McpInvocationContext.McpInvocationScope;

type LinkedResult<A> = {
  readonly environmentId: EnvironmentId;
  readonly data: A | null;
  readonly diagnostic: LinkedDeliveryDiagnostic | null;
};

type LinkedRequest = LinkedDeliveryRead | LinkedDeliveryAction;
type LinkedOperation = LinkedRequest["operation"];
type LinkedResultData<K extends LinkedOperation> = (typeof LinkedDeliveryResults)[K]["Type"];
type LinkedTarget = {
  readonly peerEnvironmentId: EnvironmentId;
  readonly fresh?: boolean | undefined;
};
const noLinkedResult = (environmentId: EnvironmentId, diagnostic: LinkedDeliveryDiagnostic) => ({
  environmentId,
  data: null,
  diagnostic,
});

const linkedCacheKey = (link: PeerLink, request: LinkedRequest) =>
  JSON.stringify([link.environmentId, link.access, DateTime.formatIso(link.linkedAt), request]);

const actionOperations = new Set<LinkedOperation>([
  "comment",
  "answer",
  "control",
  "steer",
  "take",
  "renew",
  "release",
]);
const cachedOperations = new Set<LinkedOperation>([
  "boards",
  "board",
  "search",
  "task",
  "messages",
  "timeline",
]);

/**
 * Runs T3 MCP tools in a linked environment for an agent here. The tool's own
 * declaration checks the agent here first; the linked environment then holds
 * the call to the link's access, narrowed to the agent's modes, which every
 * forwarded call carries.
 */
export class PeerForwarding extends Context.Service<
  PeerForwarding,
  {
    /**
     * Runs `tool` in the linked environment `environmentId` with `params`. A
     * `t3_thread_wait` goes in pieces short enough to survive any route.
     */
    readonly call: <T extends Tool.Any>(
      scope: Scope,
      tool: T,
      environmentId: EnvironmentId,
      params: Tool.Parameters<T>,
    ) => Effect.Effect<Tool.Success<T>, OrchestratorMcpFailure>;
    readonly listLinkedBoards: (input: {
      readonly fresh?: boolean | undefined;
    }) => Effect.Effect<typeof LinkedDeliveryBoardsResult.Type>;
    readonly linkedDelivery: <K extends LinkedOperation>(
      target: LinkedTarget,
      request: LinkedRequest & { readonly operation: K },
    ) => Effect.Effect<LinkedResult<LinkedResultData<K>>>;
    readonly readLinkedAsAgent: (
      scope: Scope,
      target: LinkedTarget,
      request: LinkedDeliveryRead,
    ) => Effect.Effect<LinkedResult<LinkedResultData<LinkedDeliveryRead["operation"]>>>;
    /** Discovery keeps routing failures as bounded diagnostics, not peer-supplied error text. */
    readonly readDelivery: (
      scope: Scope,
      input: DeliveryDiscoveryInput,
      environmentId?: EnvironmentId,
    ) => Effect.Effect<DeliveryDiscoverySnapshot, never, DeliveryService.DeliveryService>;
    /** `t3_thread_read` there. */
    readonly readThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadReadInput,
    ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
    /** `t3_thread_interrupt` there. */
    readonly interruptThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadInterruptInput,
    ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
    /** `t3_thread_wait` there, bounded like a local wait. */
    readonly waitForThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadWaitInput,
    ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
    /** The environments this one links to, as an agent sees them. */
    readonly links: (
      scope: Scope,
    ) => Effect.Effect<OrchestratorMcpEnvironmentLinksResult, OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerForwarding") {}

/** What an agent hears when it names another machine while the beta is off here. */
export const linkedEnvironmentsOff = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "Linked environments is off on this machine, so no tool can act on another machine. Leave out environmentId to work here; the user can turn it on in Settings → Labs.",
});

const isRuntimeMode = Schema.is(RuntimeMode);

const linkStorageFailure = (error: PeerLinkError) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

/** The linked environment a call names, or nothing when it names this one. */
export const remoteTarget = (scope: Scope, environmentId: EnvironmentId | undefined) =>
  environmentId === scope.environmentId ? undefined : environmentId;

// Older peers reject beforePosition during parameter validation.
const BEFORE_POSITION_REFUSAL =
  /^Invalid parameters for tool 't3_thread_read': Unknown arguments? (?:"[^"]+", )*"beforePosition"(?:, "[^"]+")*\. Accepted arguments: /;
export const refusesBeforePosition = (failure: {
  readonly code: string;
  readonly message: string;
}) => failure.code === "invalid_request" && BEFORE_POSITION_REFUSAL.test(failure.message);

/** A newest-page read, retried as the peer always served it when the peer refuses the cursor. */
export const readNewestOrRetry = Effect.fn("PeerForwarding.readNewestOrRetry")(function* <A>(
  read: (args: unknown) => Effect.Effect<A, OrchestratorMcpFailure>,
  newest: unknown,
  params: unknown,
) {
  return yield* read(newest).pipe(Effect.catchIf(refusesBeforePosition, () => read(params)));
});

const make = Effect.gen(function* () {
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const links = yield* PeerLinks.PeerLinks;
  const crypto = yield* Digest.Digest;
  const threads = yield* ThreadManagement.ThreadManagementService;

  /**
   * The caller's own limits and thread, which travel with every forwarded call: the peer sees only the
   * link's credential, so a caller that may not control threads here is refused here. Work a
   * link started never uses this environment's links, since the peer would see this
   * environment's session instead of that link, and its fence could not hold.
   */
  const forwardingCaller = (scope: Scope) =>
    readCaller().pipe(
      Effect.tap((caller) => assertNotLinked(caller, "use this environment's links")),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );

  /**
   * Every caller here reaches the peer as the one link session, so a retry
   * key is scoped to its caller before it leaves: two agents here reusing a
   * key never collide there, and one agent retrying gets its first result.
   */
  const scopedRequestId = (namespace: string, clientRequestId: string) =>
    crypto.digest(Digest.sha256, new TextEncoder().encode(`${namespace}\n${clientRequestId}`)).pipe(
      Effect.map((digest) => `fwd:${Hex.encode(digest)}`),
      Effect.orDie,
    );

  /**
   * The linked environment refuses a mode above the link's access too, but as
   * "broader than parent mode", which misleads when the parent here is broader.
   * A read-only link refuses the launch there with its own capability error,
   * and an expired one is left to say it expired.
   */
  const assertWithinLinkAccess = Effect.fn("PeerForwarding.assertWithinLinkAccess")(function* (
    environmentId: EnvironmentId,
    requested: unknown,
  ) {
    if (!isRuntimeMode(requested)) return;
    const link = yield* links.get(environmentId).pipe(Effect.mapError(linkStorageFailure));
    if (Option.isNone(link)) return;
    if (DateTime.isLessThanOrEqualTo(link.value.expiresAt, yield* DateTime.now)) return;
    const { label, access } = link.value;
    if (access === "read-only" || runtimeModeRank(requested) <= runtimeModeRank(access)) return;
    return yield* new OrchestratorMcpFailure({
      code: "runtime_mode_escalation_denied",
      message: `Linked environment "${label}" was linked with ${access} access, so work there cannot run in ${requested}. Omit runtimeMode to run it at a mode up to ${access}, or link it again with broader access.`,
    });
  });

  /** Tool and contract schemas are plain data: they encode and decode without services. */
  const forward = Effect.fn("PeerForwarding.forward")(function* <A>(
    scope: Scope,
    toolName: string,
    parameters: Schema.Top,
    success: Schema.Top,
    environmentId: EnvironmentId,
    params: unknown,
  ) {
    const { caller, limits } = yield* forwardingCaller(scope);
    const encoded = (yield* Schema.encodeUnknownEffect(parameters as Schema.Encoder<unknown>)(
      params,
    ).pipe(Effect.mapError(unavailable))) as Record<string, unknown>;
    const { environmentId: _target, ...args } = encoded;
    yield* assertWithinLinkAccess(environmentId, args.runtimeMode);
    // A pending upload lives here, so it cannot go with the call.
    if (Array.isArray(args.attachments) && args.attachments.length > 0) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "A launch in a linked environment cannot carry attachments yet.",
      });
    }
    if (typeof args.clientRequestId === "string") {
      args.clientRequestId = yield* scopedRequestId(scope.requestNamespace, args.clientRequestId);
    }
    // So a message sent there names the thread that sent it, even to a client that cannot reach here.
    const sender =
      caller === undefined
        ? undefined
        : {
            environmentId: scope.environmentId,
            threadId: caller.id,
            title: caller.title,
          };
    return yield* peers.call({
      environmentId,
      tool: toolName,
      arguments: args,
      limits,
      ...(sender === undefined ? {} : { sender }),
      success: success as Schema.Decoder<A>,
    });
  });

  const linkedCache = new Map<
    string,
    {
      readonly environmentId: EnvironmentId;
      readonly until: number;
      readonly read: Effect.Effect<LinkedResult<LinkedResultData<LinkedOperation>>>;
    }
  >();
  const cacheLock = yield* Semaphore.make(1);
  const evictLinked = (environmentId: EnvironmentId) => {
    for (const [key, entry] of linkedCache) {
      if (entry.environmentId === environmentId) linkedCache.delete(key);
    }
  };

  const linkedDelivery = Effect.fn("PeerForwarding.linkedDelivery")(function* (
    target: LinkedTarget,
    request: LinkedRequest,
  ) {
    const { peerEnvironmentId: environmentId } = target;
    if (!(yield* links.enabled)) return noLinkedResult(environmentId, "not-linked");
    const stored = yield* links.get(environmentId).pipe(Effect.result);
    if (stored._tag === "Failure") return noLinkedResult(environmentId, "offline");
    if (Option.isNone(stored.success)) return noLinkedResult(environmentId, "not-linked");
    const link = stored.success.value;
    if (DateTime.isLessThanOrEqualTo(link.expiresAt, yield* DateTime.now)) {
      return noLinkedResult(environmentId, "unauthorized");
    }
    const action = actionOperations.has(request.operation);
    if (action && link.access === "read-only") return noLinkedResult(environmentId, "read-only");

    const call = Effect.suspend(() =>
      peers.call({
        environmentId,
        tool: action ? "delivery_linked_act" : "delivery_linked_read",
        arguments: { request },
        limits: { runtimeMode: "full-access", interactionMode: "default" },
        success: linkedDeliveryResult(LinkedDeliveryResults[request.operation]),
        maxResponseBytes: 10 * 1024 * 1024,
      }),
    ).pipe(
      Effect.timeout("15 seconds"),
      Effect.map((result) =>
        result.environmentId === environmentId
          ? result
          : noLinkedResult(environmentId, "environment-mismatch"),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          noLinkedResult(
            environmentId,
            error._tag !== "OrchestratorMcpFailure"
              ? "offline"
              : error.code === "capability_denied"
                ? "unauthorized"
                : error.code === "environment_mismatch"
                  ? "environment-mismatch"
                  : error.code === "response_too_large"
                    ? "response-too-large"
                    : error.code === "invalid_request"
                      ? "unsupported"
                      : "offline",
          ),
        ),
      ),
    );
    if (action) {
      evictLinked(environmentId);
      return yield* call.pipe(Effect.ensuring(Effect.sync(() => evictLinked(environmentId))));
    }
    if (!cachedOperations.has(request.operation)) return yield* call;
    const key = linkedCacheKey(link, request);
    const read = yield* cacheLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const existing = linkedCache.get(key);
        if (!target.fresh && existing !== undefined && existing.until > now) return existing.read;
        const shared = yield* Effect.cached(
          call.pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                if (result.diagnostic !== null && linkedCache.get(key)?.read === shared)
                  linkedCache.delete(key);
              }),
            ),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                if (linkedCache.get(key)?.read === shared) linkedCache.delete(key);
              }),
            ),
          ),
        );
        const oldest = linkedCache.keys().next();
        if (linkedCache.size >= 12 && !oldest.done) linkedCache.delete(oldest.value);
        linkedCache.set(key, { environmentId, until: now + 5_000, read: shared });
        return shared;
      }),
    );
    return yield* read;
  });

  const listLinkedBoards = Effect.fn("PeerForwarding.listLinkedBoards")(function* (input: {
    readonly fresh?: boolean | undefined;
  }) {
    if (!(yield* links.enabled)) return { links: [], diagnostic: "not-linked" as const };
    const listed = yield* links.listStored.pipe(Effect.result);
    if (listed._tag === "Failure") return { links: [], diagnostic: "offline" as const };
    const statuses = yield* Effect.forEach(
      listed.success,
      (link) =>
        linkedDelivery(
          { ...input, peerEnvironmentId: link.environmentId },
          { operation: "boards" },
        ).pipe(
          Effect.map((result) => ({
            ...result,
            data: result.data !== null && "boards" in result.data ? result.data : null,
            label: link.label,
            access: link.access,
          })),
        ),
      { concurrency: 4 },
    );
    return { links: statuses, diagnostic: null };
  });

  const readLinkedAsAgent = Effect.fn("PeerForwarding.readLinkedAsAgent")(function* (
    scope: Scope,
    target: LinkedTarget,
    request: LinkedDeliveryRead,
  ) {
    const { peerEnvironmentId } = target;
    if (!scope.capabilities.has("orchestration") || scope.client?.linked === true) {
      return noLinkedResult(peerEnvironmentId, "unauthorized");
    }
    if (scope.linkedEnvironments === false) return noLinkedResult(peerEnvironmentId, "not-linked");
    const caller = yield* forwardingCaller(scope).pipe(Effect.option);
    if (Option.isNone(caller) || callerLinkOrigin(caller.value) !== undefined) {
      return noLinkedResult(peerEnvironmentId, "unauthorized");
    }
    return yield* linkedDelivery(target, request);
  });

  const readDelivery = Effect.fn("PeerForwarding.readDelivery")(function* (
    scope: Scope,
    input: DeliveryDiscoveryInput,
    environmentId?: EnvironmentId,
  ): Effect.fn.Return<DeliveryDiscoverySnapshot, never, DeliveryService.DeliveryService> {
    const target = remoteTarget(scope, environmentId);
    if (scope.client?.linked === true) {
      return {
        ...emptyDiscovery(
          input,
          { environmentId: target ?? scope.environmentId },
          "unavailable",
          DateTime.formatIso(yield* DateTime.now),
          null,
        ),
        diagnostics: ["unauthorized"],
      };
    }
    if (target === undefined) {
      const delivery = yield* DeliveryService.DeliveryService;
      return yield* delivery.discover(input, {
        environmentId: scope.environmentId,
        authorized: scope.capabilities.has("orchestration"),
        ...(scope.thread === undefined
          ? {}
          : {
              threadId: scope.thread.threadId,
              providerInstanceId: scope.thread.providerInstanceId,
            }),
        toolsSupported: true,
      });
    }
    const empty = emptyDiscovery(
      input,
      { environmentId: target },
      "remote",
      DateTime.formatIso(yield* DateTime.now),
      null,
    );
    if (invalidDiscoveryCards(input)) return { ...empty, diagnostics: ["invalid-request"] };
    if (input.preflight || input.cards || input.task || input.route || input.team) {
      return { ...empty, diagnostics: ["unsupported-server"] };
    }
    const read = yield* readLinkedAsAgent(
      scope,
      { peerEnvironmentId: target, fresh: input.fresh },
      {
        operation: "boards",
      },
    );
    if (read.data !== null && "boards" in read.data) {
      const boards = read.data.boards.filter(
        ({ id }) => input.board === undefined || input.board === id,
      );
      return {
        ...empty,
        boards: boards.slice(0, 12).map(({ id }) => ({ id, branch: null })),
        truncated: boards.length > 12,
      };
    }
    switch (read.diagnostic) {
      case "unauthorized":
      case "environment-mismatch":
      case "response-too-large":
        return { ...empty, diagnostics: [read.diagnostic] };
      case "not-linked":
        return { ...empty, diagnostics: ["remote-unpaired"] };
      case "unsupported":
        return { ...empty, diagnostics: ["unsupported-server"] };
      default:
        return { ...empty, diagnostics: ["unreachable"] };
    }
  });

  const readThread: PeerForwarding["Service"]["readThread"] = (scope, environmentId, input) =>
    forward<OrchestratorMcpThreadReadResult>(
      scope,
      "t3_thread_read",
      OrchestratorMcpThreadReadInput,
      OrchestratorMcpThreadReadResult,
      environmentId,
      input,
    );

  const interruptThread: PeerForwarding["Service"]["interruptThread"] = (
    scope,
    environmentId,
    input,
  ) =>
    forward<OrchestratorMcpThreadInterruptResult>(
      scope,
      "t3_thread_interrupt",
      OrchestratorMcpThreadInterruptInput,
      OrchestratorMcpThreadInterruptResult,
      environmentId,
      input,
    );

  const waitForThread: PeerForwarding["Service"]["waitForThread"] = (scope, environmentId, input) =>
    forward<OrchestratorMcpThreadWaitResult>(
      scope,
      "t3_thread_wait",
      OrchestratorMcpThreadWaitInput,
      OrchestratorMcpThreadWaitResult,
      environmentId,
      {
        ...input,
        timeoutMs: Math.min(
          MAX_WAIT_TIMEOUT_MS,
          Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
        ),
      },
    );

  // While the beta is off, agents start nothing over links. Tasks already running there keep
  // following through readThread, waitForThread and interruptThread, so they still finish.
  const requireEnabled = links.enabled.pipe(
    Effect.flatMap((enabled) => (enabled ? Effect.void : Effect.fail(linkedEnvironmentsOff))),
  );

  // A peer pages a client's cursorless read forward; an agent's gets the newest page, as it does here.
  const newestPageForAgent = (scope: Scope, toolName: string, params: unknown) => {
    if (toolName !== "t3_thread_read" || scope.thread === undefined) return undefined;
    const input = params as OrchestratorMcpThreadReadInput;
    return input.afterPosition === undefined && input.beforePosition === undefined
      ? { ...input, beforePosition: Number.MAX_SAFE_INTEGER }
      : undefined;
  };

  const call: PeerForwarding["Service"]["call"] = (scope, tool, environmentId, params) => {
    const forwardTool = (
      args: unknown,
    ): Effect.Effect<Tool.Success<typeof tool>, OrchestratorMcpFailure> =>
      forward(scope, tool.name, tool.parametersSchema, tool.successSchema, environmentId, args);
    const newest = newestPageForAgent(scope, tool.name, params);
    const forwarded: Effect.Effect<
      Tool.Success<typeof tool>,
      OrchestratorMcpFailure
    > = tool.name === "t3_thread_wait"
      ? (waitForThread(
          scope,
          environmentId,
          params as OrchestratorMcpThreadWaitInput,
        ) as Effect.Effect<Tool.Success<typeof tool>, OrchestratorMcpFailure>)
      : newest === undefined
        ? forwardTool(params)
        : readNewestOrRetry(forwardTool, newest, params);
    return Effect.andThen(requireEnabled, forwarded);
  };

  /**
   * The next step for an agent whose machine is not linked: without it, an
   * empty list reads as a dead end and agents go looking elsewhere.
   */
  const NOT_LISTED =
    "Not listed: not linked yet. Call t3_environment_link with a hint from the user's words.";

  const listLinks: PeerForwarding["Service"]["links"] = Effect.fn("PeerForwarding.listLinks")(
    function* (scope) {
      yield* forwardingCaller(scope);
      yield* requireEnabled;
      const listed = yield* links.list.pipe(Effect.mapError(linkStorageFailure));
      return {
        environmentId: scope.environmentId,
        links: listed.map((link) => ({
          environmentId: link.environmentId,
          label: link.label,
          status: link.status,
          access: link.access,
          expiresAt: DateTime.formatIso(link.expiresAt),
          lastError: link.lastError,
        })),
        notListed: NOT_LISTED,
      };
    },
  );

  return PeerForwarding.of({
    call,
    readDelivery,
    listLinkedBoards,
    linkedDelivery: linkedDelivery as PeerForwarding["Service"]["linkedDelivery"],
    readLinkedAsAgent: readLinkedAsAgent as PeerForwarding["Service"]["readLinkedAsAgent"],
    readThread,
    interruptThread,
    waitForThread,
    links: listLinks,
  });
});

export const layer = Layer.effect(PeerForwarding, make);
