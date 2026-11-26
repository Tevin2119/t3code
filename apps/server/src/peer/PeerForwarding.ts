import {
  type EnvironmentId,
  DeliveryError,
  LinkedArrivalProofResult,
  LINKED_HANDOFF_MCP_MAX_BYTES,
  linkedHandoffPeerResult,
  LinkedHandoffPeerResponses,
  type LinkedHandoffPeerRequest,
  DeliveryDiscoveryInput,
  type DeliveryDiscoverySnapshot,
  type LinkedDeliveryDiagnostic,
  LinkedDeliveryRead,
  LinkedDeliveryAction,
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
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
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
import { makeLinkedHandoffs, type LinkedHandoffs } from "../delivery/linkedHandoffs.ts";
import { linkedReturnPeer } from "../delivery/linkedReturn.ts";
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

const isLinkedRequest = Schema.is(Schema.Union([LinkedDeliveryRead, LinkedDeliveryAction]));

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
    readonly bringLinkedTask: LinkedHandoffs["bring"];
    readonly sendLinkedTask: LinkedHandoffs["send"];
    readonly listLinkedHandoffs: LinkedHandoffs["list"];
    readonly retryLinkedHandoff: LinkedHandoffs["retry"];
    readonly receiveLinkedHandoff: (
      request: LinkedHandoffPeerRequest,
    ) => Effect.Effect<
      (typeof LinkedHandoffPeerResponses)[LinkedHandoffPeerRequest["operation"]]["Type"],
      DeliveryError,
      | DeliveryService.DeliveryService
      | McpInvocationContext.McpInvocationContext
      | ServerEnvironment.ServerEnvironment
    >;
    readonly linkedSendDestination: LinkedHandoffs["sendDestination"];
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
  const random = yield* SecureRandom.SecureRandom;
  const newId = random.uuidV4().pipe(Effect.orDie);
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
    if (!isLinkedRequest(request)) return noLinkedResult(environmentId, "refused");
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

  const handoffLink = Effect.fn("PeerForwarding.handoffLink")(function* (
    environmentId: EnvironmentId,
    acting: boolean,
  ) {
    const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
    if (McpInvocationContext.isLinkedDeliveryCaller(Option.getOrUndefined(scope))) {
      return yield* new DeliveryError({
        reason: "refused",
        detail: "A peer cannot forward a hand-off.",
      });
    }
    if (!(yield* links.enabled)) {
      return yield* new DeliveryError({
        reason: "disabled",
        detail: "Linked environments are turned off.",
      });
    }
    const found = yield* links.get(environmentId).pipe(
      Effect.mapError(
        () =>
          new DeliveryError({
            reason: "unreachable",
            detail: "The peer link could not be read.",
          }),
      ),
    );
    if (
      Option.isNone(found) ||
      DateTime.isLessThanOrEqualTo(found.value.expiresAt, yield* DateTime.now)
    ) {
      return yield* new DeliveryError({
        reason: "refused",
        detail: "The peer link is missing or expired.",
      });
    }
    if (acting && found.value.access === "read-only") {
      return yield* new DeliveryError({ reason: "refused", detail: "The peer link is read-only." });
    }
    return found.value;
  });

  const handoffPhase = Effect.fn("PeerForwarding.handoffPhase")(function* <
    Request extends LinkedHandoffPeerRequest,
  >(
    environmentId: EnvironmentId,
    request: Request,
  ): Effect.fn.Return<
    (typeof LinkedHandoffPeerResponses)[Request["operation"]]["Type"],
    DeliveryError
  > {
    const acting = request.operation !== "get" && request.operation !== "list";
    const carriesBundle = request.operation === "prepare" || request.operation === "import";
    yield* handoffLink(environmentId, acting);
    const success = LinkedHandoffPeerResponses[request.operation] as Schema.Decoder<
      (typeof LinkedHandoffPeerResponses)[Request["operation"]]["Type"]
    >;
    if (acting) evictLinked(environmentId);
    const result = yield* peers
      .call({
        environmentId,
        tool: acting ? "delivery_linked_handoff" : "delivery_linked_handoff_read",
        arguments: { request },
        limits: { runtimeMode: "full-access", interactionMode: "default" },
        success: linkedHandoffPeerResult(success),
        maxResponseBytes:
          request.operation === "prepare" ? LINKED_HANDOFF_MCP_MAX_BYTES : 10 * 1024 * 1024,
      })
      .pipe(
        Effect.timeout(carriesBundle ? "60 seconds" : "15 seconds"),
        Effect.mapError(
          () =>
            new DeliveryError({
              reason: "unreachable",
              detail: "The linked machine did not confirm the hand-off phase.",
            }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (acting) evictLinked(environmentId);
          }),
        ),
      );
    if (result.environmentId !== environmentId) {
      return yield* new DeliveryError({
        reason: "invalid",
        detail: "The hand-off answered from another environment.",
      });
    }
    if (result.error !== null) {
      return yield* new DeliveryError({
        reason: result.error.refused ? "refused" : "unreachable",
        detail: result.error.message.slice(0, 500),
        ...(result.error.status === undefined ? {} : { status: result.error.status }),
      });
    }
    return result.data;
  });

  const provePeer = Effect.fn("PeerForwarding.provePeer")(function* (
    sessionId: string,
    expectedPeer?: EnvironmentId,
  ) {
    if (!(yield* links.enabled)) return null;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    const challenge = yield* newId;
    const stored = yield* links.listStored.pipe(Effect.orElseSucceed(() => []));
    const now = yield* DateTime.now;
    const eligible = stored.filter(
      (link) =>
        (expectedPeer === undefined || link.environmentId === expectedPeer) &&
        link.access !== "read-only" &&
        DateTime.isGreaterThan(link.expiresAt, now),
    );
    const matching = yield* Effect.forEach(
      eligible,
      (link) =>
        Effect.gen(function* () {
          const callerSessionId = yield* links.actingSessionId(link.environmentId);
          if (callerSessionId === null) return null;
          const proof = yield* links.challengeArrival(
            sessionId,
            challenge,
            link.environmentId,
            callerSessionId,
          );
          if (proof === null) return null;
          const answer = yield* peers
            .call({
              environmentId: link.environmentId,
              tool: "delivery_linked_origin",
              arguments: { environmentId, challenge, claim: proof.claim },
              limits: { runtimeMode: "full-access", interactionMode: "default" },
              success: LinkedArrivalProofResult,
              maxResponseBytes: 4096,
            })
            .pipe(Effect.timeout("15 seconds"));
          return answer.environmentId === link.environmentId &&
            answer.proof !== null &&
            (yield* proof.verify(answer.proof))
            ? link.environmentId
            : null;
        }).pipe(Effect.orElseSucceed(() => null)),
      { concurrency: 4 },
    );
    const matches = matching.filter((peer) => peer !== null);
    return matches.length === 1 ? (matches[0] ?? null) : null;
  });

  const receiveLinkedHandoff = Effect.fn("PeerForwarding.receiveLinkedHandoff")(function* (
    request: LinkedHandoffPeerRequest,
  ) {
    const { client, capabilities } = yield* McpInvocationContext.McpInvocationContext;
    const delivery = yield* DeliveryService.DeliveryService;
    const peer =
      request.operation === "import"
        ? linkedReturnPeer(request.bundle.handoff)
        : request.operation === "settle"
          ? linkedReturnPeer(request.handoff)
          : null;
    const verified =
      peer !== null &&
      client?.linked === true &&
      client.access !== "read-only" &&
      capabilities.has("orchestration")
        ? yield* provePeer(client.sessionId, peer)
        : null;
    return yield* delivery.peerHandoff(request, verified ?? undefined);
  });

  const resolveArrivalPeer = Effect.fn("PeerForwarding.resolveArrivalPeer")(function* (
    peer: string,
    expectedPeer?: EnvironmentId,
  ) {
    const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
    if (
      McpInvocationContext.isLinkedDeliveryCaller(Option.getOrUndefined(scope)) ||
      !(yield* links.enabled)
    )
      return null;
    return yield* provePeer(peer, expectedPeer);
  });

  const returnId = Effect.fn("PeerForwarding.returnId")(function* (handoff: string) {
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const id = yield* environment.getEnvironmentId;
    const suffix = yield* crypto.digestHex(Digest.sha256, new TextEncoder().encode(handoff));
    return `back-${id}-${suffix.slice(0, 32)}`;
  });

  const handoffs = makeLinkedHandoffs(
    handoffPhase,
    (environmentId) => handoffLink(environmentId, true),
    links.listStored.pipe(
      Effect.map((stored) => stored.map((link) => link.environmentId)),
      Effect.mapError(
        () =>
          new DeliveryError({ reason: "unreachable", detail: "The peer links could not be read." }),
      ),
    ),
    newId,
    returnId,
    resolveArrivalPeer,
  );

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
    if (
      !scope.capabilities.has("orchestration") ||
      McpInvocationContext.isLinkedDeliveryCaller(scope)
    ) {
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
    if (McpInvocationContext.isLinkedDeliveryCaller(scope)) {
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
    bringLinkedTask: handoffs.bring,
    sendLinkedTask: handoffs.send,
    listLinkedHandoffs: handoffs.list,
    retryLinkedHandoff: handoffs.retry,
    linkedSendDestination: handoffs.sendDestination,
    receiveLinkedHandoff,
    linkedDelivery: linkedDelivery as PeerForwarding["Service"]["linkedDelivery"],
    readLinkedAsAgent: readLinkedAsAgent as PeerForwarding["Service"]["readLinkedAsAgent"],
    readThread,
    interruptThread,
    waitForThread,
    links: listLinks,
  });
});

export const layer = Layer.effect(PeerForwarding, make);
